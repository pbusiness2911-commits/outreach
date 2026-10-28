// Continue a campaign that another tool (e.g. lemlist) already started from the same Gmail mailboxes.
// Gmail is the source of truth: for every queued lead we look for emails this campaign's mailboxes already sent them,
// record those as completed steps (same thread, same sender), and schedule only the next step.
// Replies, auto-replies and bounces found in Gmail go through the normal inbound handler, so they stop the lead.
import type { Ctx } from './context.js';
import { logEvent } from './context.js';
import { handleInbound } from './sync.js';
import { parseAddress } from '../lib/classify.js';
import { leadVars, renderTemplate } from '../lib/render.js';
import type { GmailMessageMeta } from '../lib/gmail.js';

const DAY = 86400000;

type Sent = { mailboxId: number; mailbox: string; id: string; threadId: string; date: number; subject: string; rfcId: string | null; text: string };

export interface ResumeReport {
  apply: boolean;
  since: string;
  leads_checked: number;
  not_contacted: number;
  continuing: Record<string, number>; // "next step N" -> leads
  sequence_finished: number;
  replied: number;
  bounced: number;
  auto_replied: number;
  already_resumed: number;
  mailbox_errors: string[];
  samples: { email: string; steps_sent: number; mailbox: string; last_sent: string; next: string }[];
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const norm = (s: string) => s.replace(/^\s*(re|fwd?):\s*/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function resumeFromGmail(ctx: Ctx, campaignId: number, opts: { since: Date; apply: boolean }): Promise<ResumeReport> {
  const db = ctx.db;
  const campaign = (await db.query(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]))[0];
  if (!campaign) throw new Error('Campaign not found');
  if (opts.apply && campaign.status === 'running') throw new Error('Pause the campaign before resuming leads from Gmail.');
  const steps = await db.query(`SELECT * FROM steps WHERE campaign_id = $1 ORDER BY position`, [campaignId]);
  for (const s of steps) s.variants = await db.query(`SELECT * FROM step_variants WHERE step_id = $1 ORDER BY id`, [s.id]);
  const mailboxes = await db.query(`SELECT mb.* FROM mailboxes mb JOIN campaign_mailboxes cm ON cm.mailbox_id = mb.id WHERE cm.campaign_id = $1`, [campaignId]);
  if (!mailboxes.length) throw new Error('Choose the campaign mailboxes first (the ones that sent the earlier emails).');

  const cls = await db.query(
    `SELECT cl.id, cl.status, cl.next_step, l.* , cl.id AS cl_id
       FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $1`,
    [campaignId],
  );
  const byEmail = new Map<string, any>();
  for (const c of cls) byEmail.set(c.email.toLowerCase(), c);

  const report: ResumeReport = {
    apply: opts.apply, since: opts.since.toISOString(), leads_checked: cls.length, not_contacted: 0, continuing: {}, sequence_finished: 0,
    replied: 0, bounced: 0, auto_replied: 0, already_resumed: 0, mailbox_errors: [], samples: [],
  };
  const after = Math.floor(opts.since.getTime() / 1000);

  // 1. Everything these mailboxes sent since the campaign started, matched to our leads by recipient.
  const sentByLead = new Map<string, Sent[]>();
  for (const mb of mailboxes) {
    let ids: string[] = [];
    try {
      ids = await ctx.mail.search(mb.email, `in:sent after:${after}`);
    } catch (err: any) {
      report.mailbox_errors.push(`${mb.email}: ${err.message}`);
      continue;
    }
    await pool(ids, 6, async (id) => {
      const m: GmailMessageMeta = await ctx.mail.getMessage(mb.email, id);
      const recipients = (m.headers.to || '').split(',').map((x) => parseAddress(x)).filter(Boolean);
      for (const r of recipients) {
        if (!byEmail.has(r)) continue;
        const list = sentByLead.get(r) || [];
        list.push({ mailboxId: mb.id, mailbox: mb.email, id: m.id, threadId: m.threadId, date: m.internalDate, subject: m.headers.subject || '', rfcId: m.headers['message-id'] || null, text: m.text });
        sentByLead.set(r, list);
      }
    });
  }
  if (report.mailbox_errors.length && opts.apply) throw new Error(`Could not read every mailbox, nothing changed: ${report.mailbox_errors.join('; ')}`);

  // 2. Per lead: completed steps = emails already sent (in date order), next step scheduled from the last one.
  const touched: { cl: any; sent: Sent[] }[] = [];
  for (const cl of cls) {
    const sent = (sentByLead.get(cl.email.toLowerCase()) || []).sort((a, b) => a.date - b.date);
    if (!sent.length) {
      if (cl.status === 'queued' && cl.next_step === 0) report.not_contacted++;
      continue;
    }
    if (cl.status !== 'queued' || cl.next_step !== 0) {
      report.already_resumed++;
      continue;
    }
    const first = sent[0];
    const own = sent.filter((s) => s.mailboxId === first.mailboxId).slice(0, steps.length); // one sender per lead
    const done = own.length;
    const last = own[done - 1];

    // Which A/B variant did they get? Match the first subject, then keep the same label on later steps.
    const variantMap: Record<number, number> = {};
    const mb = mailboxes.find((m: any) => m.id === first.mailboxId);
    const vars = leadVars(cl, mb);
    const matched = steps[0].variants.find((v: any) => {
      try {
        return norm(renderTemplate(v.subject, vars, 'match')) === norm(first.subject);
      } catch {
        return false;
      }
    });
    if (matched) for (const s of steps) {
      const v = s.variants.find((x: any) => x.label === matched.label);
      if (v) variantMap[s.position] = v.id;
    }

    const finished = done >= steps.length;
    const nextAt = finished ? new Date(last.date) : new Date(Math.max(last.date + steps[done].delay_days * DAY, ctx.now().getTime()));
    const key = finished ? 'finished' : `next step ${done + 1}`;
    if (finished) report.sequence_finished++;
    else report.continuing[key] = (report.continuing[key] || 0) + 1;
    if (report.samples.length < 15) {
      report.samples.push({ email: cl.email, steps_sent: done, mailbox: first.mailbox, last_sent: new Date(last.date).toISOString(), next: finished ? 'none (sequence done)' : `step ${done + 1} on ${nextAt.toISOString().slice(0, 10)}` });
    }
    if (!opts.apply) continue;

    await db.tx(async (q) => {
      for (let i = 0; i < own.length; i++) {
        const s = own[i];
        await q.query(
          `INSERT INTO messages(campaign_lead_id, lead_id, campaign_id, mailbox_id, step_position, variant_id, direction, kind, status,
                                from_email, to_email, subject, body, rfc_message_id, gmail_message_id, gmail_thread_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'out','sequence','sent',$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
          [cl.cl_id, cl.id, campaignId, s.mailboxId, i, variantMap[i] ?? null, s.mailbox, cl.email, s.subject, s.text, s.rfcId, s.id, s.threadId, new Date(s.date)],
        );
      }
      await q.query(
        `UPDATE campaign_leads SET status = $2, status_detail = $3, next_step = $4, next_send_at = $5, mailbox_id = $6,
                thread_id = $7, last_rfc_id = $8, first_subject = $9, variant_map = $10
          WHERE id = $1 AND status = 'queued'`,
        [cl.cl_id, finished ? 'completed' : 'active', `continued from Gmail history (${done} sent before)`, done, nextAt, first.mailboxId,
          first.threadId, last.rfcId, first.subject, JSON.stringify(variantMap)],
      );
    });
    touched.push({ cl, sent: own });
  }

  // 3. Replies, auto-replies and bounces since the campaign started: the normal inbound handler stops those leads.
  if (opts.apply) {
    const before = await db.query(`SELECT status, count(*)::int AS n FROM campaign_leads WHERE campaign_id = $1 GROUP BY 1`, [campaignId]);
    for (const mb of mailboxes) {
      const mine = touched.filter((t) => t.sent[0].mailboxId === mb.id);
      const queries = [`from:mailer-daemon after:${after}`, `from:postmaster after:${after}`, ...mine.map((t) => `from:${t.cl.email} after:${after}`)];
      const ids = new Set<string>();
      await pool(queries, 6, async (qry) => {
        for (const id of await ctx.mail.search(mb.email, qry, 50)) ids.add(id);
      });
      await pool([...ids], 4, async (id) => {
        const known = await db.query(`SELECT 1 FROM messages WHERE mailbox_id = $1 AND gmail_message_id = $2`, [mb.id, id]);
        if (known.length) return;
        const m = await ctx.mail.getMessage(mb.email, id);
        if (m.labelIds.includes('SENT') || m.labelIds.includes('DRAFT')) return;
        await handleInbound(ctx, mb, m);
      });
    }
    const after2 = await db.query(`SELECT status, count(*)::int AS n FROM campaign_leads WHERE campaign_id = $1 GROUP BY 1`, [campaignId]);
    const count = (rows: any[], s: string) => rows.find((r) => r.status === s)?.n || 0;
    report.replied = count(after2, 'replied') - count(before, 'replied');
    report.bounced = count(after2, 'bounced') - count(before, 'bounced');
    const stoppedNow = await db.query(`SELECT count(*)::int AS n FROM campaign_leads WHERE campaign_id = $1 AND status_detail = 'auto-reply'`, [campaignId]);
    report.auto_replied = stoppedNow[0].n;
    await logEvent(db, 'info', 'campaign', `Continued ${touched.length} leads from Gmail history`, { campaign_id: campaignId });
  }
  return report;
}
