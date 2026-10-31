import { Ctx, logEvent, suppress, FREE_MAIL_DOMAINS } from './context.js';
import { classify, parseAddress, bouncedAddress, isHardBounce, wantsUnsubscribe, freshText } from '../lib/classify.js';
import { GmailError } from '../lib/gmail.js';
import { config } from '../config.js';

/** Reads new inbox mail for one mailbox: detects replies, bounces, auto-replies and unsubscribe requests. */
export async function syncMailbox(ctx: Ctx, mb: any): Promise<number> {
  const now = ctx.now();
  const since = mb.last_synced_at ? new Date(mb.last_synced_at).getTime() - 30 * 60000 : now.getTime() - 3 * 86400000;
  let ids: string[];
  try {
    ids = await ctx.mail.listInbox(mb.email, since / 1000);
  } catch (err) {
    if (err instanceof GmailError && err.authProblem) {
      await ctx.db.query(`UPDATE mailboxes SET status = 'error', paused_reason = $2 WHERE id = $1`, [mb.id, `Gmail access problem: ${err.message}`]);
      await logEvent(ctx.db, 'error', 'mailbox', `Paused ${mb.email}: cannot read inbox (${err.message})`, { mailbox_id: mb.id });
    }
    throw err;
  }
  let handled = 0;
  for (const id of ids) {
    const known = await ctx.db.query(`SELECT 1 FROM messages WHERE mailbox_id = $1 AND gmail_message_id = $2`, [mb.id, id]);
    if (known.length) continue;
    const m = await ctx.mail.getMessage(mb.email, id);
    if (await handleInbound(ctx, mb, m)) handled++;
  }
  await ctx.db.query(`UPDATE mailboxes SET last_synced_at = $2 WHERE id = $1`, [mb.id, now]);
  return handled;
}

export async function handleInbound(ctx: Ctx, mb: any, m: { id: string; threadId: string; headers: Record<string, string>; text: string; snippet: string }) {
  const from = parseAddress(m.headers.from);
  if (from === mb.email.toLowerCase()) return false;
  const subject = m.headers.subject || '';
  const kind = classify({ from, subject, text: m.text, headers: m.headers });

  // Which of our conversations is this? Thread first, then In-Reply-To/References, then sender address.
  let cl: any = null;
  const thread = await ctx.db.query(
    `SELECT campaign_lead_id FROM messages WHERE mailbox_id = $1 AND gmail_thread_id = $2 AND direction = 'out' AND campaign_lead_id IS NOT NULL LIMIT 1`,
    [mb.id, m.threadId],
  );
  if (thread.length) cl = await getCl(ctx, thread[0].campaign_lead_id);
  if (!cl) {
    const refIds = `${m.headers['in-reply-to'] || ''} ${m.headers.references || ''}`.match(/<[^>]+>/g) || [];
    if (refIds.length) {
      const r = await ctx.db.query(`SELECT campaign_lead_id FROM messages WHERE rfc_message_id = ANY($1) AND campaign_lead_id IS NOT NULL LIMIT 1`, [refIds]);
      if (r.length) cl = await getCl(ctx, r[0].campaign_lead_id);
    }
  }

  if (kind === 'bounce') {
    if (!cl) {
      // match the bounced address against people this mailbox emailed recently
      const recent = await ctx.db.query(
        `SELECT DISTINCT to_email FROM messages WHERE mailbox_id = $1 AND direction = 'out' AND created_at > $2`,
        [mb.id, new Date(ctx.now().getTime() - 14 * 86400000)],
      );
      const addr = bouncedAddress({ from, subject, text: m.text, headers: m.headers }, recent.map((r: any) => r.to_email));
      if (addr) {
        const r = await ctx.db.query(
          `SELECT cl.id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = $1 AND cl.mailbox_id = $2 ORDER BY cl.id DESC LIMIT 1`,
          [addr, mb.id],
        );
        if (r.length) cl = await getCl(ctx, r[0].id);
      }
    }
    if (!cl) return false;
    await storeInbound(ctx, mb, m, cl, 'bounce', from, subject);
    if (isHardBounce(m.text)) {
      await suppress(ctx.db, cl.email, 'email', 'bounced');
      await ctx.db.query(`UPDATE leads SET verification_status = 'invalid', verification_detail = 'hard bounce' WHERE id = $1`, [cl.lead_id]);
      await logEvent(ctx.db, 'warn', 'bounce', `Hard bounce from ${cl.email}; added to do-not-contact list`, { mailbox_id: mb.id, campaign_id: cl.campaign_id, lead_id: cl.lead_id });
    } else {
      await logEvent(ctx.db, 'info', 'bounce', `Temporary delivery problem for ${cl.email}`, { mailbox_id: mb.id, campaign_id: cl.campaign_id, lead_id: cl.lead_id });
    }
    return true;
  }

  if (!cl) {
    // A message from a lead that this mailbox emailed, outside the thread (e.g. a new email)
    const r = await ctx.db.query(
      `SELECT cl.id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = $1 AND cl.mailbox_id = $2 ORDER BY cl.id DESC LIMIT 1`,
      [from, mb.id],
    );
    if (r.length) cl = await getCl(ctx, r[0].id);
  }
  if (!cl) return false; // not related to outreach: leave it alone

  await storeInbound(ctx, mb, m, cl, kind, from, subject);
  const refs = { mailbox_id: mb.id, campaign_id: cl.campaign_id, lead_id: cl.lead_id };

  if (kind === 'auto_reply') {
    if (cl.stop_on_auto_reply && ['queued', 'active'].includes(cl.status)) {
      await ctx.db.query(`UPDATE campaign_leads SET status = 'stopped', status_detail = 'auto-reply' WHERE id = $1`, [cl.id]);
    }
    await logEvent(ctx.db, 'info', 'reply', `Auto-reply from ${from}`, refs);
    return true;
  }

  // Real reply
  if (wantsUnsubscribe(m.text)) {
    await suppress(ctx.db, cl.email, 'email', 'unsubscribed');
    await logEvent(ctx.db, 'info', 'unsubscribe', `${cl.email} asked to be removed (reply)`, refs);
  }
  if (cl.stop_on_reply) {
    await ctx.db.query(`UPDATE campaign_leads SET status = 'replied', status_detail = NULL WHERE id = $1 AND status IN ('queued','active','sending','completed')`, [cl.id]);
    // stop this person in every other campaign too
    await ctx.db.query(
      `UPDATE campaign_leads SET status = 'stopped', status_detail = 'replied in another campaign' WHERE lead_id = $1 AND id <> $2 AND status IN ('queued','active')`,
      [cl.lead_id, cl.id],
    );
    if (cl.stop_on_company_reply && !FREE_MAIL_DOMAINS.has(cl.domain)) {
      await ctx.db.query(
        `UPDATE campaign_leads cl SET status = 'stopped', status_detail = 'a colleague replied'
           FROM leads l WHERE l.id = cl.lead_id AND l.domain = $1 AND cl.lead_id <> $2 AND cl.status IN ('queued','active')`,
        [cl.domain, cl.lead_id],
      );
    }
  }
  await logEvent(ctx.db, 'info', 'reply', `Reply from ${from}: ${m.snippet.slice(0, 120)}`, refs);
  await notifyReply(ctx, cl, from, m.text || m.snippet);
  return true;
}

/** Plain-English phone alert: the "Replies" app (REPLIES_HOOK_URL) and/or ntfy (NTFY_TOPIC). Never blocks syncing. */
async function notifyReply(ctx: Ctx, cl: any, from: string, text: string) {
  if (!config.ntfyTopic && !config.repliesHookUrl) return;
  try {
    const [who] = await ctx.db.query(
      `SELECT l.first_name, l.last_name, l.company, c.name AS campaign FROM leads l, campaigns c WHERE l.id = $1 AND c.id = $2`,
      [cl.lead_id, cl.campaign_id],
    );
    const name = [who?.first_name, who?.last_name].filter(Boolean).join(' ') || from;
    const title = who?.company ? `${name} from ${who.company} replied` : `${name} replied`;
    const words = readableReply(text);
    if (config.repliesHookUrl) {
      // Same fields lemlist sends, so the existing phone app reads it unchanged
      await fetch(config.repliesHookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leadFirstName: who?.first_name || '', leadLastName: who?.last_name || '', leadEmail: from,
          leadCompanyName: who?.company || '', campaignName: who?.campaign || '', text: words,
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    if (!config.ntfyTopic) return;
    const body = `"${words}"

Campaign: ${who?.campaign ?? ''}
Tap to open and answer.`;
    await fetch(`https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`, {
      method: 'POST',
      headers: {
        // HTTP headers must be plain ASCII; ntfy decodes RFC 2047 for anything else
        Title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`,
        Click: `${config.publicUrl}/inbox`,
        Tags: 'speech_balloon',
        Priority: 'high',
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* a missed notification must not break inbox sync */
  }
}

/** Only what the person newly wrote: no quoted thread, signature or line noise. */
export function readableReply(text: string) {
  const fresh = freshText(text)
    .split(/\n(?:--\s*\n|sent from my |get outlook for )/i)[0]
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return fresh.length > 280 ? `${fresh.slice(0, 277).trimEnd()}...` : fresh || '(no text, open to see it)';
}

async function getCl(ctx: Ctx, id: number) {
  return (
    await ctx.db.query(
      `SELECT cl.*, l.email, l.domain, c.stop_on_reply, c.stop_on_company_reply, c.stop_on_auto_reply
         FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.id = $1`,
      [id],
    )
  )[0];
}

async function storeInbound(ctx: Ctx, mb: any, m: any, cl: any, kind: string, from: string, subject: string) {
  await ctx.db.query(
    `INSERT INTO messages(campaign_lead_id, lead_id, campaign_id, mailbox_id, direction, kind, status, from_email, to_email, subject, body,
                          rfc_message_id, gmail_message_id, gmail_thread_id, created_at)
     VALUES ($1,$2,$3,$4,'in',$5,'sent',$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT DO NOTHING`,
    [cl.id, cl.lead_id, cl.campaign_id, mb.id, kind, from, mb.email, subject, m.text, m.headers['message-id'] || null, m.id, m.threadId, ctx.now()],
  );
}

/** Sync every active mailbox that hasn't been synced in the last 2 minutes. */
export async function syncTick(ctx: Ctx) {
  const due = await ctx.db.query(
    `SELECT * FROM mailboxes WHERE status IN ('active','paused') AND (last_synced_at IS NULL OR last_synced_at < $1)`,
    [new Date(ctx.now().getTime() - 2 * 60000)],
  );
  for (const mb of due) {
    try {
      await syncMailbox(ctx, mb);
    } catch (err: any) {
      await logEvent(ctx.db, 'warn', 'sync', `Inbox check failed for ${mb.email}: ${err.message}`, { mailbox_id: mb.id });
    }
  }
}
