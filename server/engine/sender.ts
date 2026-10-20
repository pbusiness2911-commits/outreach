import { Ctx, logEvent, isSuppressed, settings, FREE_MAIL_DOMAINS } from './context.js';
import { renderTemplate, leadVars, MissingVariableError, textToHtml } from '../lib/render.js';
import { inWindow, nextWindowStart, scheduleNext, randomBetween, isValidTimezone, type Window } from '../lib/schedule.js';
import { buildMime, newMessageId } from '../lib/mime.js';
import { GmailError } from '../lib/gmail.js';
import { makeToken } from '../lib/tokens.js';
import { isRoleAddress } from '../lib/verify.js';
import { syncMailbox } from './sync.js';

/** Today's sending cap for a mailbox, including gradual ramp-up. */
export function mailboxCap(mb: any, now: Date): number {
  if (!mb.ramp_enabled) return mb.daily_limit;
  const days = Math.max(0, Math.floor((now.getTime() - new Date(mb.ramp_started_at).getTime()) / 86400000));
  return Math.min(mb.daily_limit, mb.ramp_start + mb.ramp_increment * days);
}

export async function sentLast24h(ctx: Ctx, mailboxId: number): Promise<number> {
  const r = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE mailbox_id = $1 AND direction = 'out' AND status IN ('sent','pending','unknown') AND created_at > $2`,
    [mailboxId, new Date(ctx.now().getTime() - 86400000)],
  );
  return r[0].n;
}

export function windowFor(campaign: any, lead: any): Window {
  const tz = campaign.use_lead_timezone && isValidTimezone(lead.timezone) ? lead.timezone : campaign.timezone;
  return { timezone: tz, sendDays: campaign.send_days, start: campaign.window_start, end: campaign.window_end };
}

/** One pass: each mailbox that is allowed to send right now sends at most one email. */
export async function sendTick(ctx: Ctx): Promise<number> {
  await reconcileStuck(ctx);
  const now = ctx.now();
  const mailboxes = await ctx.db.query(`SELECT * FROM mailboxes WHERE status = 'active' AND next_send_at <= $1 ORDER BY random()`, [now]);
  let sent = 0;
  for (const mb of mailboxes) {
    try {
      if (await sendOne(ctx, mb)) sent++;
    } catch (err: any) {
      await logEvent(ctx.db, 'error', 'sender', `Unexpected error for ${mb.email}: ${err.message}`, { mailbox_id: mb.id });
    }
  }
  return sent;
}

async function sendOne(ctx: Ctx, mb: any): Promise<boolean> {
  const now = ctx.now();
  if ((await sentLast24h(ctx, mb.id)) >= mailboxCap(mb, now)) return false;

  // Follow-ups first, then new leads; only campaigns this mailbox belongs to
  const candidates = await ctx.db.query(
    `SELECT cl.id AS cl_id, cl.status AS cl_status, cl.next_step, cl.mailbox_id, cl.campaign_id, cl.created_at AS cl_created,
            l.*, c.id AS c_id
       FROM campaign_leads cl
       JOIN campaigns c ON c.id = cl.campaign_id
       JOIN leads l ON l.id = cl.lead_id
      WHERE c.status = 'running' AND cl.status IN ('queued','active') AND cl.next_send_at <= $1
        AND (cl.mailbox_id = $2 OR (cl.mailbox_id IS NULL AND EXISTS (
              SELECT 1 FROM campaign_mailboxes cm WHERE cm.campaign_id = c.id AND cm.mailbox_id = $2)))
      ORDER BY (cl.status = 'active') DESC, cl.next_send_at ASC
      LIMIT 25`,
    [now, mb.id],
  );
  if (!candidates.length) return false;

  const campaignCache = new Map<number, any>();
  for (const cand of candidates) {
    let campaign = campaignCache.get(cand.campaign_id);
    if (!campaign) {
      campaign = (await ctx.db.query(`SELECT * FROM campaigns WHERE id = $1`, [cand.campaign_id]))[0];
      campaignCache.set(cand.campaign_id, campaign);
    }
    const win = windowFor(campaign, cand);
    if (!inWindow(now, win)) {
      await ctx.db.query(`UPDATE campaign_leads SET next_send_at = $2 WHERE id = $1 AND status IN ('queued','active')`, [cand.cl_id, nextWindowStart(now, win)]);
      continue;
    }
    if (cand.cl_status === 'queued' && (await newLeadsToday(ctx, campaign.id)) >= campaign.daily_new_leads) continue;
    if (cand.verification_status === 'unverified') continue; // the verifier will get to it first

    // Claim the mailbox slot first (prevents two sends from one mailbox), then the lead.
    const gap = randomBetween(mb.min_gap_seconds, mb.max_gap_seconds) * 1000;
    const slot = await ctx.db.query(`UPDATE mailboxes SET next_send_at = $2 WHERE id = $1 AND next_send_at <= $3 AND status = 'active' RETURNING id`, [
      mb.id, new Date(now.getTime() + gap), now,
    ]);
    if (!slot.length) return false;
    const claimed = await ctx.db.query(
      `UPDATE campaign_leads SET status = 'sending', claimed_at = $2 WHERE id = $1 AND status IN ('queued','active') RETURNING *`,
      [cand.cl_id, now],
    );
    if (!claimed.length) {
      await ctx.db.query(`UPDATE mailboxes SET next_send_at = $2 WHERE id = $1`, [mb.id, now]); // give the slot back
      continue;
    }
    const sent = await deliver(ctx, mb, campaign, cand, claimed[0], cand.cl_status);
    if (sent) return true;
    // Nothing went out: give the mailbox slot back (unless deliver() set a longer wait) and try the next lead
    await ctx.db.query(`UPDATE mailboxes SET next_send_at = $2 WHERE id = $1 AND next_send_at = $3`, [mb.id, now, new Date(now.getTime() + gap)]);
  }
  return false;
}

async function newLeadsToday(ctx: Ctx, campaignId: number) {
  const r = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE campaign_id = $1 AND direction = 'out' AND kind = 'sequence' AND step_position = 0
       AND status IN ('sent','pending','unknown') AND created_at > $2`,
    [campaignId, new Date(ctx.now().getTime() - 86400000)],
  );
  return r[0].n;
}

async function release(ctx: Ctx, clId: number, prevStatus: string, retryAt: Date | null, mailboxId: number) {
  await ctx.db.query(`UPDATE campaign_leads SET status = $2, claimed_at = NULL, next_send_at = COALESCE($3, next_send_at) WHERE id = $1 AND status = 'sending'`, [
    clId, prevStatus, retryAt,
  ]);
  void mailboxId;
}

async function finish(ctx: Ctx, clId: number, status: string, detail: string) {
  await ctx.db.query(`UPDATE campaign_leads SET status = $2, status_detail = $3, claimed_at = NULL WHERE id = $1`, [clId, status, detail]);
}

/** Every safety check, then the actual send. Called with the lead claimed (status 'sending'). */
async function deliver(ctx: Ctx, mb: any, campaign: any, lead: any, cl: any, prevStatus: string): Promise<boolean> {
  const now = ctx.now();
  const refs = { mailbox_id: mb.id, campaign_id: campaign.id, lead_id: lead.id };
  const cfg = await settings(ctx.db);

  // 1. Do-not-contact list
  const supp = await isSuppressed(ctx.db, lead.email);
  if (supp) return finish(ctx, cl.id, supp === 'bounced' ? 'bounced' : supp === 'unsubscribed' ? 'unsubscribed' : 'stopped', `suppressed: ${supp}`).then(() => false);

  // 2. List quality
  if (cfg.block_role_addresses && isRoleAddress(lead.email)) return finish(ctx, cl.id, 'skipped', 'role address (info@, support@...)').then(() => false);
  const v = lead.verification_status;
  if (v === 'invalid') return finish(ctx, cl.id, 'skipped', `email invalid: ${lead.verification_detail || ''}`).then(() => false);
  if (v === 'catch_all' && !campaign.allow_catch_all) return finish(ctx, cl.id, 'skipped', 'catch-all domain (allow in campaign settings)').then(() => false);
  if (v === 'risky' && ctx.fullVerification && !campaign.allow_unverified) return finish(ctx, cl.id, 'skipped', `risky email: ${lead.verification_detail || ''}`).then(() => false);

  // 3. Make sure we've seen the latest replies before a follow-up
  if (cl.next_step > 0) {
    const fresh = mb.last_synced_at && now.getTime() - new Date(mb.last_synced_at).getTime() < 5 * 60000;
    if (!fresh) {
      try {
        await syncMailbox(ctx, mb);
      } catch (err: any) {
        await release(ctx, cl.id, prevStatus, new Date(now.getTime() + 15 * 60000), mb.id);
        await logEvent(ctx.db, 'warn', 'sender', `Could not check replies for ${mb.email} before a follow-up, will retry: ${err.message}`, refs);
        return false;
      }
    }
    const still = await ctx.db.query(`SELECT status FROM campaign_leads WHERE id = $1`, [cl.id]);
    if (still[0]?.status !== 'sending') return false; // a reply/bounce just stopped it
  }

  // 4. Replied anywhere (any campaign) or someone at the company replied
  const replied = await ctx.db.query(
    `SELECT 1 FROM messages m JOIN leads l ON l.id = m.lead_id
      WHERE m.direction = 'in' AND m.kind = 'reply' AND m.created_at > $2
        AND (l.id = $1 OR ($3::boolean AND l.domain = $4))
      LIMIT 1`,
    [lead.id, cl.created_at, campaign.stop_on_company_reply && !FREE_MAIL_DOMAINS.has(lead.domain), lead.domain],
  );
  if (replied.length) return finish(ctx, cl.id, 'stopped', 'lead or their company already replied').then(() => false);

  // 5. Step + variant
  const step = (await ctx.db.query(`SELECT * FROM steps WHERE campaign_id = $1 AND position = $2`, [campaign.id, cl.next_step]))[0];
  if (!step) return finish(ctx, cl.id, 'completed', 'sequence finished').then(() => false);
  const variants = await ctx.db.query(`SELECT * FROM step_variants WHERE step_id = $1 AND active ORDER BY id`, [step.id]);
  if (!variants.length) {
    await release(ctx, cl.id, prevStatus, new Date(now.getTime() + 3600000), mb.id);
    await logEvent(ctx.db, 'warn', 'sender', `Campaign "${campaign.name}" step ${step.position + 1} has no active email`, refs);
    return false;
  }
  const map = cl.variant_map || {};
  let variant = variants.find((x: any) => x.id === map[step.position]);
  if (!variant) {
    const total = variants.reduce((s: number, x: any) => s + Math.max(1, x.weight), 0);
    let r = Math.random() * total;
    variant = variants.find((x: any) => (r -= Math.max(1, x.weight)) < 0) || variants[0];
  }

  // 6. Render — refuse to send if a variable is missing
  const threaded = step.position > 0 && !step.new_thread && cl.thread_id;
  const vars = leadVars(lead, mb);
  let subject: string, body: string;
  try {
    const seed = `${cl.id}:${step.position}`;
    body = renderTemplate(variant.body, vars, seed);
    subject = threaded ? `Re: ${(cl.first_subject || '').replace(/^re:\s*/i, '')}` : renderTemplate(variant.subject, vars, seed);
  } catch (err) {
    const msg = err instanceof MissingVariableError ? err.message : `Template error: ${(err as Error).message}`;
    await finish(ctx, cl.id, 'error', msg);
    await logEvent(ctx.db, 'warn', 'sender', `Not sent to ${lead.email}: ${msg}`, refs);
    return false;
  }
  if (!subject.trim()) {
    await finish(ctx, cl.id, 'error', 'empty subject');
    return false;
  }
  if (mb.signature) body = `${body}\n\n${renderTemplate(mb.signature, vars, `${cl.id}:sig`)}`;
  const unsubscribeUrl = `${ctx.publicUrl}/u/${makeToken('u', cl.id)}`;
  let text = body;
  if (campaign.unsubscribe_link) text += `\n\nIf you'd prefer not to hear from me again, let me know or click here: ${unsubscribeUrl}`;

  let html: string | undefined;
  if (!campaign.send_plain_text || campaign.track_opens || campaign.track_clicks) {
    html = textToHtml(text);
    if (campaign.track_clicks) {
      const ct = makeToken('c', cl.id);
      html = html.replace(/href="(https?:\/\/[^"]+)"/g, (_m, url) =>
        url.startsWith(ctx.publicUrl) ? `href="${url}"` : `href="${ctx.publicUrl}/t/c/${ct}?u=${encodeURIComponent(url)}"`,
      );
    }
    if (campaign.track_opens) html += `<img src="${ctx.publicUrl}/t/o/${makeToken('o', cl.id)}.gif" width="1" height="1" alt="" style="display:none">`;
  }

  // 7. Write the pending row BEFORE sending. The unique index makes a second send for this step impossible.
  const rfcId = newMessageId(mb.email);
  let msgRow: any;
  try {
    msgRow = (
      await ctx.db.query(
        `INSERT INTO messages(campaign_lead_id, lead_id, campaign_id, mailbox_id, step_position, variant_id, direction, kind, status,
                              from_email, to_email, subject, body, rfc_message_id, gmail_thread_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'out','sequence','pending',$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [cl.id, lead.id, campaign.id, mb.id, step.position, variant.id, mb.email, lead.email, subject, text, rfcId, threaded ? cl.thread_id : null, now],
      )
    )[0];
  } catch (err: any) {
    await finish(ctx, cl.id, 'error', 'duplicate send prevented');
    await logEvent(ctx.db, 'error', 'sender', `Duplicate send prevented for ${lead.email} step ${step.position + 1}`, refs);
    return false;
  }

  const raw = buildMime({
    fromEmail: mb.email, fromName: mb.from_name, to: lead.email,
    toName: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined,
    subject, text, html, messageId: rfcId,
    inReplyTo: threaded ? cl.last_rfc_id : null,
    references: threaded ? cl.last_rfc_id : null,
    unsubscribeUrl, unsubscribeMailto: mb.email,
  });

  let result: { id: string; threadId: string };
  try {
    result = await ctx.mail.send(mb.email, raw, threaded ? cl.thread_id : null);
  } catch (err: any) {
    if (err instanceof GmailError && err.status > 0) {
      // Google answered with an error: nothing was sent, safe to remove the pending row
      await ctx.db.query(`DELETE FROM messages WHERE id = $1`, [msgRow.id]);
      if (err.authProblem) {
        await ctx.db.query(`UPDATE mailboxes SET status = 'error', paused_reason = $2 WHERE id = $1`, [mb.id, `Gmail access problem: ${err.message}`]);
        await release(ctx, cl.id, prevStatus, null, mb.id);
        await logEvent(ctx.db, 'error', 'mailbox', `Paused ${mb.email}: Gmail access problem (${err.message})`, refs);
      } else if (err.retryable) {
        await ctx.db.query(`UPDATE mailboxes SET next_send_at = $2 WHERE id = $1`, [mb.id, new Date(now.getTime() + 30 * 60000)]);
        await release(ctx, cl.id, prevStatus, new Date(now.getTime() + 30 * 60000), mb.id);
        await logEvent(ctx.db, 'warn', 'mailbox', `Gmail rate limit for ${mb.email}, waiting 30 minutes`, refs);
      } else {
        await finish(ctx, cl.id, 'error', err.message.slice(0, 300));
        await logEvent(ctx.db, 'warn', 'sender', `Gmail rejected email to ${lead.email}: ${err.message}`, refs);
      }
      return false;
    }
    // No answer (timeout / network): it MAY have been sent. Leave it for reconcileStuck to check, never resend blindly.
    await ctx.db.query(`UPDATE messages SET status = 'unknown', error = $2 WHERE id = $1`, [msgRow.id, String(err?.message || err).slice(0, 300)]);
    await logEvent(ctx.db, 'warn', 'sender', `Send to ${lead.email} timed out; will check Gmail before doing anything else`, refs);
    return false;
  }

  await markSent(ctx, campaign, lead, cl, step, variant.id, msgRow.id, result, rfcId, subject, mb.id);
  return true;
}

async function markSent(ctx: Ctx, campaign: any, lead: any, cl: any, step: any, variantId: number, messageId: number, result: { id: string; threadId: string }, rfcId: string, subject: string, mailboxId: number) {
  const now = ctx.now();
  const nextStep = (await ctx.db.query(`SELECT delay_days FROM steps WHERE campaign_id = $1 AND position = $2`, [campaign.id, step.position + 1]))[0];
  const map = { ...(cl.variant_map || {}), [step.position]: variantId };
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE messages SET status = 'sent', gmail_message_id = $2, gmail_thread_id = $3, error = NULL WHERE id = $1`, [messageId, result.id, result.threadId]);
    await q.query(
      `UPDATE campaign_leads SET
          status = $2, status_detail = $3, next_step = $4, next_send_at = $5, mailbox_id = $6,
          thread_id = COALESCE(thread_id, $7), last_rfc_id = $8, first_subject = COALESCE(first_subject, $9),
          variant_map = $10, claimed_at = NULL
        WHERE id = $1`,
      [
        cl.id,
        nextStep ? 'active' : 'completed',
        nextStep ? null : 'sequence finished',
        step.position + 1,
        nextStep ? scheduleNext(now, nextStep.delay_days, windowFor(campaign, lead)) : now,
        mailboxId,
        result.threadId,
        rfcId,
        subject,
        JSON.stringify(map),
      ],
    );
  });
}

/** Leads stuck in "sending" (crash or timeout): check Gmail for the Message-ID to learn whether it really went out. */
export async function reconcileStuck(ctx: Ctx) {
  const cutoff = new Date(ctx.now().getTime() - 5 * 60000);
  const stuck = await ctx.db.query(`SELECT * FROM campaign_leads WHERE status = 'sending' AND claimed_at < $1`, [cutoff]);
  for (const cl of stuck) {
    const msg = (
      await ctx.db.query(
        `SELECT m.*, mb.email AS mb_email FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
          WHERE m.campaign_lead_id = $1 AND m.direction = 'out' AND m.kind = 'sequence' AND m.status IN ('pending','unknown')`,
        [cl.id],
      )
    )[0];
    if (!msg) {
      await ctx.db.query(`UPDATE campaign_leads SET status = CASE WHEN next_step = 0 THEN 'queued' ELSE 'active' END, claimed_at = NULL WHERE id = $1`, [cl.id]);
      continue;
    }
    let found: { id: string; threadId: string } | null;
    try {
      found = await ctx.mail.findByRfcId(msg.mb_email, msg.rfc_message_id);
    } catch {
      continue; // try again next tick; the lead stays parked, never double-sent
    }
    if (found) {
      const campaign = (await ctx.db.query(`SELECT * FROM campaigns WHERE id = $1`, [cl.campaign_id]))[0];
      const lead = (await ctx.db.query(`SELECT * FROM leads WHERE id = $1`, [cl.lead_id]))[0];
      const step = (await ctx.db.query(`SELECT * FROM steps WHERE campaign_id = $1 AND position = $2`, [cl.campaign_id, msg.step_position]))[0];
      await markSent(ctx, campaign, lead, cl, step ?? { position: msg.step_position }, msg.variant_id, msg.id, found, msg.rfc_message_id, msg.subject, msg.mailbox_id);
      await logEvent(ctx.db, 'info', 'sender', `Confirmed earlier send to ${lead.email} went out`, { campaign_id: cl.campaign_id, lead_id: cl.lead_id });
    } else if (msg.created_at < new Date(ctx.now().getTime() - 15 * 60000)) {
      // Gmail has no record after 15 minutes: it was not sent. Safe to retry later.
      await ctx.db.query(`DELETE FROM messages WHERE id = $1`, [msg.id]);
      await ctx.db.query(
        `UPDATE campaign_leads SET status = CASE WHEN next_step = 0 THEN 'queued' ELSE 'active' END, claimed_at = NULL, next_send_at = $2 WHERE id = $1`,
        [cl.id, new Date(ctx.now().getTime() + 10 * 60000)],
      );
    }
  }
}

