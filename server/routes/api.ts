import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../engine/context.js';
import { logEvent, suppress, settings, DEFAULT_SETTINGS } from '../engine/context.js';
import { config } from '../config.js';
import { sessionValue, checkSession, validApiKey } from '../lib/tokens.js';
import { resumeFromGmail } from '../engine/resume.js';
import { normalizeEmail, isValidSyntax, isRoleAddress } from '../lib/verify.js';
import { renderTemplate, leadVars, requiredVariables, MissingVariableError } from '../lib/render.js';
import { isValidTimezone } from '../lib/schedule.js';
import { buildMime, newMessageId } from '../lib/mime.js';
import { mailboxCap, sentLast24h } from '../engine/sender.js';
import { dnsTick } from '../engine/health.js';
import { syncMailbox } from '../engine/sync.js';
import { freshText } from '../lib/classify.js';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

function cookie(req: Request, name: string) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const LEAD_FIELDS = ['email', 'first_name', 'last_name', 'company', 'title', 'phone', 'website', 'linkedin', 'city', 'timezone'] as const;

export function apiRouter(ctx: Ctx) {
  const r = Router();
  const db = ctx.db;

  // ---------- auth ----------
  const attempts = new Map<string, { n: number; until: number }>();
  r.post('/login', wrap(async (req, res) => {
    const ip = req.ip || 'x';
    const a = attempts.get(ip);
    if (a && a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const pw = String(req.body?.password || '');
    const expected = config.adminPassword || 'admin';
    const ok = pw.length === expected.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(expected));
    if (!ok) {
      const n = (a?.n || 0) + 1;
      attempts.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60000 : 0 });
      return res.status(401).json({ error: 'Wrong password' });
    }
    attempts.delete(ip);
    res.setHeader('Set-Cookie', `sid=${sessionValue()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${config.production ? '; Secure' : ''}`);
    res.json({ ok: true });
  }));
  r.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true });
  });
  r.use((req, res, next) => (checkSession(cookie(req, 'sid')) || validApiKey(req.headers.authorization) ? next() : res.status(401).json({ error: 'Not logged in' })));
  r.get('/me', (_req, res) => res.json({ ok: true, dryRun: config.dryRun || !config.serviceAccountJson, verifier: !!config.millionVerifierKey }));

  // ---------- dashboard ----------
  r.get('/dashboard', wrap(async (_req, res) => {
    const d1 = new Date(Date.now() - 86400000), d7 = new Date(Date.now() - 7 * 86400000);
    const [t] = await db.query(
      `SELECT
        count(*) FILTER (WHERE direction='out' AND status='sent' AND created_at > $1)::int AS sent_today,
        count(*) FILTER (WHERE direction='out' AND status='sent' AND created_at > $2)::int AS sent_7d,
        count(*) FILTER (WHERE direction='in' AND kind='reply' AND created_at > $2)::int AS replies_7d,
        count(*) FILTER (WHERE direction='in' AND kind='bounce' AND created_at > $2)::int AS bounces_7d,
        count(*) FILTER (WHERE direction='in' AND kind='reply' AND NOT read)::int AS unread
       FROM messages`,
      [d1, d7],
    );
    const daily = await db.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE direction='out' AND status='sent')::int AS sent,
              count(*) FILTER (WHERE direction='in' AND kind='reply')::int AS replies,
              count(*) FILTER (WHERE direction='in' AND kind='bounce')::int AS bounces
         FROM messages WHERE created_at > $1 GROUP BY 1 ORDER BY 1`,
      [new Date(Date.now() - 14 * 86400000)],
    );
    const events = await db.query(`SELECT * FROM events ORDER BY id DESC LIMIT 30`);
    const [counts] = await db.query(
      `SELECT (SELECT count(*)::int FROM campaigns WHERE status='running') AS running,
              (SELECT count(*)::int FROM mailboxes WHERE status='active') AS mailboxes_active,
              (SELECT count(*)::int FROM mailboxes WHERE status<>'active') AS mailboxes_paused`,
    );
    res.json({ totals: t, daily, events, counts });
  }));
  r.get('/events', wrap(async (req, res) => {
    const level = req.query.level ? String(req.query.level) : null;
    res.json(await db.query(`SELECT * FROM events WHERE ($1::text IS NULL OR level = $1) ORDER BY id DESC LIMIT 200`, [level]));
  }));

  // ---------- mailboxes ----------
  async function mailboxRows() {
    const rows = await db.query(
      `SELECT mb.*,
        (SELECT count(*)::int FROM messages WHERE mailbox_id=mb.id AND direction='out' AND status='sent' AND created_at > $1) AS sent_7d,
        (SELECT count(*)::int FROM messages WHERE mailbox_id=mb.id AND direction='in' AND kind='bounce' AND created_at > $1) AS bounces_7d,
        (SELECT count(*)::int FROM messages WHERE mailbox_id=mb.id AND direction='in' AND kind='reply' AND created_at > $1) AS replies_7d
       FROM mailboxes mb ORDER BY mb.email`,
      [new Date(Date.now() - 7 * 86400000)],
    );
    for (const mb of rows) {
      mb.cap_today = mailboxCap(mb, new Date());
      mb.sent_24h = await sentLast24h(ctx, mb.id);
    }
    return rows;
  }
  r.get('/mailboxes', wrap(async (_req, res) => res.json(await mailboxRows())));

  const mailboxSchema = z.object({
    email: z.string().email().optional(),
    from_name: z.string().max(100).optional(),
    signature: z.string().max(5000).optional(),
    daily_limit: z.number().int().min(1).max(100).optional(),
    ramp_enabled: z.boolean().optional(),
    ramp_start: z.number().int().min(1).max(100).optional(),
    ramp_increment: z.number().int().min(1).max(20).optional(),
    min_gap_seconds: z.number().int().min(60).max(3600).optional(),
    max_gap_seconds: z.number().int().min(60).max(7200).optional(),
  });

  r.post('/mailboxes', wrap(async (req, res) => {
    const body = mailboxSchema.parse(req.body);
    if (!body.email) return res.status(400).json({ error: 'Email is required' });
    const email = normalizeEmail(body.email);
    try {
      await ctx.mail.check(email);
    } catch (err: any) {
      return res.status(400).json({ error: `Could not connect to ${email}. Check the Google setup (SETUP.md step 3). Details: ${err.message}` });
    }
    const row = (
      await db.query(
        `INSERT INTO mailboxes(email, from_name, signature, daily_limit, ramp_enabled, ramp_start, ramp_increment, min_gap_seconds, max_gap_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (email) DO NOTHING RETURNING *`,
        [email, body.from_name ?? '', body.signature ?? '', body.daily_limit ?? 30, body.ramp_enabled ?? true, body.ramp_start ?? 5,
          body.ramp_increment ?? 2, body.min_gap_seconds ?? 240, body.max_gap_seconds ?? 600],
      )
    )[0];
    if (!row) return res.status(400).json({ error: 'That mailbox is already added' });
    await logEvent(db, 'info', 'mailbox', `Added mailbox ${email}`, { mailbox_id: row.id });
    dnsTick(ctx, true).catch(() => {});
    res.json(row);
  }));

  r.patch('/mailboxes/:id', wrap(async (req, res) => {
    const body = mailboxSchema.parse(req.body);
    if (body.min_gap_seconds && body.max_gap_seconds && body.max_gap_seconds < body.min_gap_seconds) {
      return res.status(400).json({ error: 'Max gap must be at least the min gap' });
    }
    const sets: string[] = [], vals: unknown[] = [req.params.id];
    for (const [k, v] of Object.entries(body)) {
      if (k === 'email' || v === undefined) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (sets.length) await db.query(`UPDATE mailboxes SET ${sets.join(', ')} WHERE id = $1`, vals);
    res.json((await db.query(`SELECT * FROM mailboxes WHERE id = $1`, [req.params.id]))[0]);
  }));

  r.post('/mailboxes/:id/test', wrap(async (req, res) => {
    const mb = (await db.query(`SELECT * FROM mailboxes WHERE id = $1`, [req.params.id]))[0];
    if (!mb) return res.status(404).json({ error: 'Not found' });
    try {
      await ctx.mail.check(mb.email);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }));

  r.post('/mailboxes/:id/pause', wrap(async (req, res) => {
    await db.query(`UPDATE mailboxes SET status = 'paused', paused_reason = 'Paused manually' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));

  r.post('/mailboxes/:id/resume', wrap(async (req, res) => {
    const mb = (await db.query(`SELECT * FROM mailboxes WHERE id = $1`, [req.params.id]))[0];
    if (!mb) return res.status(404).json({ error: 'Not found' });
    try {
      await ctx.mail.check(mb.email);
    } catch (err: any) {
      return res.status(400).json({ error: `Still can't connect: ${err.message}` });
    }
    const cfg = await settings(db);
    if (cfg.require_dns && mb.dns_status && !mb.dns_status.ok) {
      return res.status(400).json({ error: 'DNS records are still not correct for this domain. Fix them, then click "Check DNS".' });
    }
    await db.query(`UPDATE mailboxes SET status = 'active', paused_reason = NULL, next_send_at = now() WHERE id = $1`, [mb.id]);
    await logEvent(db, 'info', 'mailbox', `Resumed ${mb.email}`, { mailbox_id: mb.id });
    res.json({ ok: true });
  }));

  r.post('/mailboxes/:id/restart-ramp', wrap(async (req, res) => {
    await db.query(`UPDATE mailboxes SET ramp_started_at = now() WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));

  r.delete('/mailboxes/:id', wrap(async (req, res) => {
    const busy = await db.query(`SELECT 1 FROM campaign_leads WHERE mailbox_id = $1 AND status IN ('active','sending') LIMIT 1`, [req.params.id]);
    if (busy.length) return res.status(400).json({ error: 'This mailbox still has leads mid-sequence. Pause it instead.' });
    await db.query(`DELETE FROM mailboxes WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));

  r.post('/dns/check', wrap(async (_req, res) => {
    await dnsTick(ctx, true);
    res.json(await mailboxRows());
  }));

  r.post('/mailboxes/:id/sync', wrap(async (req, res) => {
    const mb = (await db.query(`SELECT * FROM mailboxes WHERE id = $1`, [req.params.id]))[0];
    res.json({ handled: await syncMailbox(ctx, mb) });
  }));

  // ---------- campaigns ----------
  async function campaignStats(id: number) {
    const [s] = await db.query(
      `SELECT
        (SELECT count(*)::int FROM campaign_leads WHERE campaign_id = $1) AS leads,
        (SELECT count(*)::int FROM campaign_leads WHERE campaign_id = $1 AND status IN ('queued')) AS queued,
        (SELECT count(*)::int FROM campaign_leads WHERE campaign_id = $1 AND status IN ('active','sending')) AS in_progress,
        (SELECT count(*)::int FROM campaign_leads WHERE campaign_id = $1 AND status = 'completed') AS completed,
        (SELECT count(*)::int FROM campaign_leads WHERE campaign_id = $1 AND status = 'replied') AS replied,
        (SELECT count(*)::int FROM campaign_leads WHERE campaign_id = $1 AND status = 'bounced') AS bounced,
        (SELECT count(*)::int FROM campaign_leads WHERE campaign_id = $1 AND status = 'unsubscribed') AS unsubscribed,
        (SELECT count(*)::int FROM campaign_leads WHERE campaign_id = $1 AND status IN ('skipped','error','stopped')) AS skipped,
        (SELECT count(DISTINCT lead_id)::int FROM messages WHERE campaign_id = $1 AND direction='out' AND status='sent') AS contacted,
        (SELECT count(*)::int FROM messages WHERE campaign_id = $1 AND direction='out' AND status='sent') AS sent,
        (SELECT count(*)::int FROM messages WHERE campaign_id = $1 AND direction='out' AND opened_at IS NOT NULL) AS opened,
        (SELECT count(*)::int FROM messages WHERE campaign_id = $1 AND direction='out' AND clicked_at IS NOT NULL) AS clicked,
        (SELECT count(*)::int FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $1 AND l.interest = 'interested') AS interested`,
      [id],
    );
    return s;
  }

  r.get('/campaigns', wrap(async (_req, res) => {
    const rows = await db.query(`SELECT * FROM campaigns ORDER BY id DESC`);
    for (const c of rows) c.stats = await campaignStats(c.id);
    res.json(rows);
  }));

  r.post('/campaigns', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim() || 'New campaign';
    const c = (await db.query(`INSERT INTO campaigns(name) VALUES ($1) RETURNING *`, [name]))[0];
    const s = (await db.query(`INSERT INTO steps(campaign_id, position, delay_days) VALUES ($1, 0, 0) RETURNING id`, [c.id]))[0];
    await db.query(`INSERT INTO step_variants(step_id, subject, body) VALUES ($1, '', '')`, [s.id]);
    res.json(c);
  }));

  async function fullCampaign(id: string | number) {
    const c = (await db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]))[0];
    if (!c) return null;
    c.steps = await db.query(`SELECT * FROM steps WHERE campaign_id = $1 ORDER BY position`, [id]);
    for (const s of c.steps) {
      s.variants = await db.query(
        `SELECT v.*,
           (SELECT count(*)::int FROM messages m WHERE m.variant_id = v.id AND m.direction='out' AND m.status='sent') AS sent,
           (SELECT count(*)::int FROM messages m WHERE m.variant_id = v.id AND m.direction='out' AND m.opened_at IS NOT NULL) AS opened,
           (SELECT count(DISTINCT i.campaign_lead_id)::int FROM messages o JOIN messages i ON i.campaign_lead_id = o.campaign_lead_id AND i.direction='in' AND i.kind='reply' AND i.created_at > o.created_at
              WHERE o.variant_id = v.id AND o.direction='out' AND o.status='sent'
                AND NOT EXISTS (SELECT 1 FROM messages o2 WHERE o2.campaign_lead_id = o.campaign_lead_id AND o2.direction='out' AND o2.created_at > o.created_at AND o2.created_at < i.created_at)) AS replies
         FROM step_variants v WHERE v.step_id = $1 ORDER BY v.id`,
        [s.id],
      );
    }
    c.mailbox_ids = (await db.query(`SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = $1`, [id])).map((x: any) => x.mailbox_id);
    c.stats = await campaignStats(c.id);
    return c;
  }
  r.get('/campaigns/:id', wrap(async (req, res) => {
    const c = await fullCampaign(String(req.params.id));
    c ? res.json(c) : res.status(404).json({ error: 'Not found' });
  }));

  const campaignSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    timezone: z.string().refine(isValidTimezone, 'Unknown time zone').optional(),
    use_lead_timezone: z.boolean().optional(),
    send_days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    window_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    window_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    daily_new_leads: z.number().int().min(1).max(1000).optional(),
    stop_on_reply: z.boolean().optional(),
    stop_on_company_reply: z.boolean().optional(),
    stop_on_auto_reply: z.boolean().optional(),
    track_opens: z.boolean().optional(),
    track_clicks: z.boolean().optional(),
    unsubscribe_link: z.boolean().optional(),
    send_plain_text: z.boolean().optional(),
    allow_catch_all: z.boolean().optional(),
    allow_unverified: z.boolean().optional(),
  });
  r.put('/campaigns/:id', wrap(async (req, res) => {
    const body = campaignSchema.parse(req.body);
    if (body.window_start && body.window_end && body.window_start >= body.window_end) return res.status(400).json({ error: 'Send window end must be after start' });
    const sets: string[] = [], vals: unknown[] = [req.params.id];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (sets.length) await db.query(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1`, vals);
    res.json(await fullCampaign(String(req.params.id)));
  }));

  const sequenceSchema = z.array(
    z.object({
      id: z.number().optional(),
      delay_days: z.number().int().min(0).max(60),
      new_thread: z.boolean().default(false),
      variants: z.array(z.object({ id: z.number().optional(), label: z.string().max(5), subject: z.string().max(300), body: z.string().max(20000), weight: z.number().int().min(1).max(100).default(1), active: z.boolean().default(true) })).min(1),
    }),
  ).min(1).max(15);

  // Saves the whole sequence. Existing steps/variants keep their ids so stats and in-flight leads stay correct.
  r.put('/campaigns/:id/sequence', wrap(async (req, res) => {
    const steps = sequenceSchema.parse(req.body);
    const id = Number(req.params.id);
    const existing = await db.query(`SELECT id, position FROM steps WHERE campaign_id = $1`, [id]);
    await db.tx(async (q) => {
      // move positions out of the way to avoid unique clashes while re-ordering
      await q.query(`UPDATE steps SET position = position + 1000 WHERE campaign_id = $1`, [id]);
      const keepSteps = new Set<number>();
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        let stepId = s.id && existing.some((e: any) => e.id === s.id) ? s.id : null;
        if (stepId) await q.query(`UPDATE steps SET position = $2, delay_days = $3, new_thread = $4 WHERE id = $1`, [stepId, i, i === 0 ? 0 : s.delay_days, s.new_thread]);
        else stepId = (await q.query(`INSERT INTO steps(campaign_id, position, delay_days, new_thread) VALUES ($1,$2,$3,$4) RETURNING id`, [id, i, i === 0 ? 0 : s.delay_days, s.new_thread]))[0].id;
        keepSteps.add(stepId!);
        const existingVariants = (await q.query(`SELECT id FROM step_variants WHERE step_id = $1`, [stepId])).map((v: any) => v.id);
        const keepVariants = new Set<number>();
        for (const v of s.variants) {
          if (v.id && existingVariants.includes(v.id)) {
            await q.query(`UPDATE step_variants SET label=$2, subject=$3, body=$4, weight=$5, active=$6 WHERE id=$1`, [v.id, v.label, v.subject, v.body, v.weight, v.active]);
            keepVariants.add(v.id);
          } else {
            const nv = (await q.query(`INSERT INTO step_variants(step_id, label, subject, body, weight, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [stepId, v.label, v.subject, v.body, v.weight, v.active]))[0];
            keepVariants.add(nv.id);
          }
        }
        for (const old of existingVariants) if (!keepVariants.has(old)) await q.query(`DELETE FROM step_variants WHERE id = $1`, [old]);
      }
      for (const e of existing) if (!keepSteps.has(e.id)) await q.query(`DELETE FROM steps WHERE id = $1`, [e.id]);
    });
    res.json(await fullCampaign(id));
  }));

  r.put('/campaigns/:id/mailboxes', wrap(async (req, res) => {
    const ids = z.array(z.number().int()).parse(req.body?.mailbox_ids);
    await db.tx(async (q) => {
      await q.query(`DELETE FROM campaign_mailboxes WHERE campaign_id = $1`, [req.params.id]);
      for (const m of ids) await q.query(`INSERT INTO campaign_mailboxes VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, m]);
    });
    res.json(await fullCampaign(String(req.params.id)));
  }));

  /** Pre-launch checks. Errors block launching; warnings are shown. */
  async function launchChecks(id: number) {
    const c = await fullCampaign(id);
    const errors: string[] = [], warnings: string[] = [];
    if (!c) return { errors: ['Campaign not found'], warnings };
    if (!c.mailbox_ids.length) errors.push('Choose at least one sending mailbox.');
    const mbs = c.mailbox_ids.length ? await db.query(`SELECT * FROM mailboxes WHERE id = ANY($1)`, [c.mailbox_ids]) : [];
    for (const mb of mbs) {
      if (mb.status !== 'active') warnings.push(`${mb.email} is ${mb.status}${mb.paused_reason ? `: ${mb.paused_reason}` : ''}. It won't send until resumed.`);
      if (mb.dns_status && !mb.dns_status.ok) warnings.push(`${mb.email}: DNS records (SPF/DKIM/DMARC) are not all correct.`);
    }
    if (mbs.length && mbs.every((m: any) => m.status !== 'active')) errors.push('None of the chosen mailboxes is active.');
    c.steps.forEach((s: any, i: number) => {
      const active = s.variants.filter((v: any) => v.active);
      if (!active.length) errors.push(`Step ${i + 1} has no active email.`);
      for (const v of active) {
        if (!v.body.trim()) errors.push(`Step ${i + 1} (${v.label}) has an empty body.`);
        if ((i === 0 || s.new_thread) && !v.subject.trim()) errors.push(`Step ${i + 1} (${v.label}) needs a subject.`);
        if (/\{\{[^}]*$|^[^{]*\}\}/.test(v.subject + v.body)) errors.push(`Step ${i + 1} (${v.label}) has a broken {{variable}}.`);
        if (/https?:\/\//.test(v.body) && i === 0) warnings.push(`Step 1 (${v.label}) has a link. Links in the first email lower inbox placement for cold outreach.`);
        if (/(free|guarantee|act now|limited time|100%|\$\$\$|click here|winner)/i.test(v.subject)) warnings.push(`Step ${i + 1} (${v.label}) subject has spam-trigger words.`);
      }
    });
    if (c.stats.queued + c.stats.in_progress === 0) errors.push('Add leads before launching.');
    // Leads that would fail on a missing variable
    const needed = new Set<string>();
    for (const s of c.steps) for (const v of s.variants) for (const x of requiredVariables(v.subject + '\n' + v.body)) needed.add(x);
    if (needed.size) {
      const leads = await db.query(`SELECT l.* FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $1 AND cl.status = 'queued'`, [id]);
      let missing = 0;
      for (const l of leads) {
        try {
          for (const x of needed) renderTemplate(`{{${x}}}`, leadVars(l, { email: '', from_name: 'x' }), 'x');
        } catch {
          missing++;
        }
      }
      if (missing) warnings.push(`${missing} lead(s) are missing a value for ${[...needed].map((x) => `{{${x}}}`).join(', ')} and will be skipped. Add a fallback like {{firstName|there}} to include them.`);
    }
    if (c.track_opens || c.track_clicks) warnings.push('Open/click tracking is on. It adds a tracking pixel/links that can lower inbox placement.');
    if (!c.unsubscribe_link) warnings.push('No unsubscribe link in the body (the one-click unsubscribe header is still sent).');
    const [{ n: unverified }] = await db.query(`SELECT count(*)::int AS n FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $1 AND cl.status='queued' AND l.verification_status='unverified'`, [id]);
    if (unverified) warnings.push(`${unverified} lead(s) are still being verified; they'll send once checked.`);
    return { errors, warnings };
  }

  r.get('/campaigns/:id/checks', wrap(async (req, res) => res.json(await launchChecks(Number(req.params.id)))));

  r.post('/campaigns/:id/launch', wrap(async (req, res) => {
    const checks = await launchChecks(Number(req.params.id));
    if (checks.errors.length) return res.status(400).json({ error: checks.errors.join(' '), ...checks });
    await db.query(`UPDATE campaigns SET status = 'running', paused_reason = NULL WHERE id = $1`, [req.params.id]);
    await logEvent(db, 'info', 'campaign', `Campaign launched`, { campaign_id: Number(req.params.id) });
    res.json({ ok: true, ...checks });
  }));
  r.post('/campaigns/:id/pause', wrap(async (req, res) => {
    await db.query(`UPDATE campaigns SET status = 'paused', paused_reason = 'Paused manually' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));

  r.post('/campaigns/:id/duplicate', wrap(async (req, res) => {
    const src = await fullCampaign(String(req.params.id));
    if (!src) return res.status(404).json({ error: 'Not found' });
    const copy = await db.tx(async (q) => {
      const c = (
        await q.query(
          `INSERT INTO campaigns(name, timezone, use_lead_timezone, send_days, window_start, window_end, daily_new_leads, stop_on_reply, stop_on_company_reply,
             stop_on_auto_reply, track_opens, track_clicks, unsubscribe_link, send_plain_text, allow_catch_all, allow_unverified)
           SELECT name || ' (copy)', timezone, use_lead_timezone, send_days, window_start, window_end, daily_new_leads, stop_on_reply, stop_on_company_reply,
             stop_on_auto_reply, track_opens, track_clicks, unsubscribe_link, send_plain_text, allow_catch_all, allow_unverified FROM campaigns WHERE id = $1 RETURNING *`,
          [src.id],
        )
      )[0];
      for (const s of src.steps) {
        const ns = (await q.query(`INSERT INTO steps(campaign_id, position, delay_days, new_thread) VALUES ($1,$2,$3,$4) RETURNING id`, [c.id, s.position, s.delay_days, s.new_thread]))[0];
        for (const v of s.variants) await q.query(`INSERT INTO step_variants(step_id, label, subject, body, weight, active) VALUES ($1,$2,$3,$4,$5,$6)`, [ns.id, v.label, v.subject, v.body, v.weight, v.active]);
      }
      for (const m of src.mailbox_ids) await q.query(`INSERT INTO campaign_mailboxes VALUES ($1,$2)`, [c.id, m]);
      return c;
    });
    res.json(copy);
  }));

  r.delete('/campaigns/:id', wrap(async (req, res) => {
    const c = (await db.query(`SELECT status FROM campaigns WHERE id = $1`, [req.params.id]))[0];
    if (c?.status === 'running') return res.status(400).json({ error: 'Pause the campaign before deleting it.' });
    await db.query(`DELETE FROM campaigns WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));

  // Preview each step exactly as a lead will get it
  r.post('/campaigns/:id/preview', wrap(async (req, res) => {
    const c = await fullCampaign(String(req.params.id));
    if (!c) return res.status(404).json({ error: 'Not found' });
    const lead = req.body?.lead_id
      ? (await db.query(`SELECT * FROM leads WHERE id = $1`, [req.body.lead_id]))[0]
      : (await db.query(`SELECT l.* FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $1 ORDER BY cl.id LIMIT 1`, [c.id]))[0] ||
        { email: 'jane@example.com', first_name: 'Jane', last_name: 'Doe', company: 'Example Co', domain: 'example.com', custom: {} };
    const mb = c.mailbox_ids.length ? (await db.query(`SELECT * FROM mailboxes WHERE id = $1`, [c.mailbox_ids[0]]))[0] : { email: 'you@yourdomain.com', from_name: 'You', signature: '' };
    let firstSubject = '';
    const out = c.steps.map((s: any, i: number) =>
      s.variants.map((v: any) => {
        try {
          const seed = `preview:${i}:${v.id}`;
          const subject = i > 0 && !s.new_thread ? `Re: ${firstSubject}` : renderTemplate(v.subject, leadVars(lead, mb), seed);
          if (i === 0 && !firstSubject) firstSubject = subject;
          let body = renderTemplate(v.body, leadVars(lead, mb), seed);
          if (mb.signature) body += `\n\n${renderTemplate(mb.signature, leadVars(lead, mb), seed)}`;
          return { step: i + 1, label: v.label, subject, body, error: null };
        } catch (err: any) {
          return { step: i + 1, label: v.label, subject: '', body: '', error: err instanceof MissingVariableError ? err.message : err.message };
        }
      }),
    );
    res.json({ lead, mailbox: mb.email, steps: out });
  }));

  // Send one step to yourself to see it in a real inbox
  r.post('/campaigns/:id/test-email', wrap(async (req, res) => {
    const to = normalizeEmail(String(req.body?.to || ''));
    if (!isValidSyntax(to)) return res.status(400).json({ error: 'Enter a valid email' });
    const c = await fullCampaign(String(req.params.id));
    if (!c?.mailbox_ids.length) return res.status(400).json({ error: 'Choose a mailbox first' });
    const mb = (await db.query(`SELECT * FROM mailboxes WHERE id = $1`, [req.body?.mailbox_id || c.mailbox_ids[0]]))[0];
    const step = c.steps[Number(req.body?.step || 0)];
    const v = step?.variants[0];
    if (!v) return res.status(400).json({ error: 'Step not found' });
    const lead = (await db.query(`SELECT l.* FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $1 ORDER BY cl.id LIMIT 1`, [c.id]))[0] || { first_name: 'Jane', company: 'Example Co', email: to, custom: {} };
    let subject: string, body: string;
    try {
      subject = `[TEST] ${renderTemplate(v.subject || 'Follow-up', leadVars(lead, mb), 't')}`;
      body = renderTemplate(v.body, leadVars(lead, mb), 't') + (mb.signature ? `\n\n${renderTemplate(mb.signature, leadVars(lead, mb), 't')}` : '');
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    const raw = buildMime({ fromEmail: mb.email, fromName: mb.from_name, to, subject, text: body, messageId: newMessageId(mb.email) });
    await ctx.mail.send(mb.email, raw);
    await db.query(`INSERT INTO messages(mailbox_id, direction, kind, status, from_email, to_email, subject, body) VALUES ($1,'out','manual','sent',$2,$3,$4,$5)`, [mb.id, mb.email, to, subject, body]);
    res.json({ ok: true });
  }));

  // ---------- leads ----------
  r.get('/campaigns/:id/leads', wrap(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const search = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    const page = Math.max(0, Number(req.query.page || 0));
    const rows = await db.query(
      `SELECT cl.id AS cl_id, cl.status, cl.status_detail, cl.next_step, cl.next_send_at, l.*, mb.email AS mailbox_email
         FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN mailboxes mb ON mb.id = cl.mailbox_id
        WHERE cl.campaign_id = $1 AND ($2::text IS NULL OR cl.status = $2) AND ($3::text IS NULL OR lower(l.email || ' ' || l.first_name || ' ' || l.last_name || ' ' || l.company) LIKE $3)
        ORDER BY cl.id LIMIT 100 OFFSET $4`,
      [req.params.id, status, search, page * 100],
    );
    const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $1 AND ($2::text IS NULL OR cl.status = $2) AND ($3::text IS NULL OR lower(l.email || ' ' || l.first_name || ' ' || l.last_name || ' ' || l.company) LIKE $3)`, [req.params.id, status, search]);
    res.json({ rows, total: n });
  }));

  // Import rows (already mapped to our field names by the browser). Custom columns go into lead.custom.
  r.post('/campaigns/:id/leads', wrap(async (req, res) => {
    const rows: Record<string, string>[] = z.array(z.record(z.string(), z.any())).max(50000).parse(req.body?.rows);
    const skipInOther = req.body?.skip_in_other_campaigns !== false;
    const campaignId = Number(req.params.id);
    const cfg = await settings(db);
    const result = { added: 0, duplicates: 0, invalid: 0, suppressed: 0, role: 0, in_other_campaign: 0 };
    const seen = new Set<string>();
    await db.tx(async (q) => {
      for (const raw of rows) {
        const email = normalizeEmail(String(raw.email || ''));
        if (!isValidSyntax(email)) { result.invalid++; continue; }
        if (seen.has(email)) { result.duplicates++; continue; }
        seen.add(email);
        const domain = email.split('@')[1];
        if ((await q.query(`SELECT 1 FROM suppressions WHERE value = $1 OR (kind='domain' AND value = $2)`, [email, domain])).length) { result.suppressed++; continue; }
        if (cfg.block_role_addresses && isRoleAddress(email)) { result.role++; continue; }
        const fields: Record<string, string> = {};
        const custom: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (v == null || v === '') continue;
          if ((LEAD_FIELDS as readonly string[]).includes(k)) fields[k] = String(v).trim();
          else custom[k] = String(v).trim();
        }
        if (fields.timezone && !isValidTimezone(fields.timezone)) delete fields.timezone;
        const lead = (
          await q.query(
            `INSERT INTO leads(email, domain, first_name, last_name, company, title, phone, website, linkedin, city, timezone, custom)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (email) DO UPDATE SET
               first_name = COALESCE(NULLIF(EXCLUDED.first_name,''), leads.first_name), last_name = COALESCE(NULLIF(EXCLUDED.last_name,''), leads.last_name),
               company = COALESCE(NULLIF(EXCLUDED.company,''), leads.company), title = COALESCE(NULLIF(EXCLUDED.title,''), leads.title),
               phone = COALESCE(NULLIF(EXCLUDED.phone,''), leads.phone), website = COALESCE(NULLIF(EXCLUDED.website,''), leads.website),
               linkedin = COALESCE(NULLIF(EXCLUDED.linkedin,''), leads.linkedin), city = COALESCE(NULLIF(EXCLUDED.city,''), leads.city),
               timezone = COALESCE(EXCLUDED.timezone, leads.timezone), custom = leads.custom || EXCLUDED.custom
             RETURNING id`,
            [email, domain, fields.first_name || '', fields.last_name || '', fields.company || '', fields.title || '', fields.phone || '', fields.website || '',
              fields.linkedin || '', fields.city || '', fields.timezone || null, JSON.stringify(custom)],
          )
        )[0];
        if (skipInOther) {
          const other = await q.query(`SELECT 1 FROM campaign_leads WHERE lead_id = $1 AND campaign_id <> $2 AND status IN ('queued','active','sending','replied') LIMIT 1`, [lead.id, campaignId]);
          if (other.length) { result.in_other_campaign++; continue; }
        }
        const ins = await q.query(`INSERT INTO campaign_leads(campaign_id, lead_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [campaignId, lead.id]);
        ins.length ? result.added++ : result.duplicates++;
      }
    });
    await logEvent(db, 'info', 'leads', `Imported ${result.added} leads`, { campaign_id: campaignId });
    res.json(result);
  }));

  // Continue leads that an earlier tool already emailed from these mailboxes (reads Gmail Sent). apply=false is a dry run.
  r.post('/campaigns/:id/resume-from-gmail', wrap(async (req, res) => {
    const since = new Date(String(req.body?.since || ''));
    if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'since must be a date, e.g. 2026-10-17' });
    res.json(await resumeFromGmail(ctx, Number(req.params.id), { since, apply: req.body?.apply === true }));
  }));

  r.post('/campaign-leads/:clId/stop', wrap(async (req, res) => {
    await db.query(`UPDATE campaign_leads SET status = 'stopped', status_detail = 'stopped manually' WHERE id = $1 AND status IN ('queued','active')`, [req.params.clId]);
    res.json({ ok: true });
  }));
  r.delete('/campaign-leads/:clId', wrap(async (req, res) => {
    await db.query(`DELETE FROM campaign_leads WHERE id = $1 AND status <> 'sending'`, [req.params.clId]);
    res.json({ ok: true });
  }));

  r.get('/leads', wrap(async (req, res) => {
    const search = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    const v = req.query.verification ? String(req.query.verification) : null;
    const page = Math.max(0, Number(req.query.page || 0));
    const rows = await db.query(
      `SELECT l.*, (SELECT string_agg(c.name || ': ' || cl.status, ', ') FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = l.id) AS campaigns
         FROM leads l WHERE ($1::text IS NULL OR lower(l.email || ' ' || l.first_name || ' ' || l.last_name || ' ' || l.company) LIKE $1)
          AND ($2::text IS NULL OR l.verification_status = $2)
        ORDER BY l.id DESC LIMIT 100 OFFSET $3`,
      [search, v, page * 100],
    );
    const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM leads l WHERE ($1::text IS NULL OR lower(l.email || ' ' || l.first_name || ' ' || l.last_name || ' ' || l.company) LIKE $1) AND ($2::text IS NULL OR l.verification_status = $2)`, [search, v]);
    const stats = await db.query(`SELECT verification_status, count(*)::int AS n FROM leads GROUP BY 1`);
    res.json({ rows, total: n, stats });
  }));
  r.patch('/leads/:id', wrap(async (req, res) => {
    const interest = req.body?.interest;
    if (interest !== undefined) {
      if (![null, 'interested', 'not_interested', 'meeting_booked'].includes(interest)) return res.status(400).json({ error: 'Bad value' });
      await db.query(`UPDATE leads SET interest = $2 WHERE id = $1`, [req.params.id, interest]);
    }
    res.json({ ok: true });
  }));
  r.post('/leads/reverify', wrap(async (req, res) => {
    const ids = z.array(z.number().int()).parse(req.body?.ids);
    await db.query(`UPDATE leads SET verification_status = 'unverified' WHERE id = ANY($1)`, [ids]);
    res.json({ ok: true });
  }));

  // ---------- unified inbox ----------
  r.get('/inbox', wrap(async (req, res) => {
    const filter = String(req.query.filter || 'all');
    const rows = await db.query(
      `SELECT DISTINCT ON (m.campaign_lead_id) m.campaign_lead_id AS cl_id, m.id, m.kind, m.subject, m.body, m.read, m.created_at,
              l.id AS lead_id, l.email, l.first_name, l.last_name, l.company, l.interest, c.name AS campaign, mb.email AS mailbox
         FROM messages m JOIN leads l ON l.id = m.lead_id LEFT JOIN campaigns c ON c.id = m.campaign_id LEFT JOIN mailboxes mb ON mb.id = m.mailbox_id
        WHERE m.direction = 'in' AND m.kind IN ('reply','auto_reply')
        ORDER BY m.campaign_lead_id, m.created_at DESC`,
    );
    let list = rows.sort((a: any, b: any) => +new Date(b.created_at) - +new Date(a.created_at));
    if (filter === 'unread') list = list.filter((x: any) => !x.read);
    if (filter === 'interested') list = list.filter((x: any) => x.interest === 'interested' || x.interest === 'meeting_booked');
    if (filter === 'replies') list = list.filter((x: any) => x.kind === 'reply');
    res.json(list.map((x: any) => ({ ...x, preview: freshText(x.body || '').slice(0, 200) })));
  }));
  r.get('/inbox/:clId', wrap(async (req, res) => {
    const msgs = await db.query(`SELECT * FROM messages WHERE campaign_lead_id = $1 AND status IN ('sent','unknown') ORDER BY created_at`, [req.params.clId]);
    const cl = (await db.query(`SELECT cl.*, l.email, l.first_name, l.last_name, l.company, l.interest, c.name AS campaign FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.id = $1`, [req.params.clId]))[0];
    await db.query(`UPDATE messages SET read = true WHERE campaign_lead_id = $1 AND direction = 'in'`, [req.params.clId]);
    res.json({ lead: cl, messages: msgs.map((m: any) => ({ ...m, fresh: m.direction === 'in' ? freshText(m.body || '') : m.body })) });
  }));
  r.post('/inbox/:clId/reply', wrap(async (req, res) => {
    const text = String(req.body?.body || '').trim();
    if (!text) return res.status(400).json({ error: 'Write a reply first' });
    const cl = (await db.query(`SELECT cl.*, l.email, l.first_name, l.last_name FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.id = $1`, [req.params.clId]))[0];
    if (!cl?.mailbox_id) return res.status(400).json({ error: 'No conversation found' });
    const mb = (await db.query(`SELECT * FROM mailboxes WHERE id = $1`, [cl.mailbox_id]))[0];
    const lastIn = (await db.query(`SELECT * FROM messages WHERE campaign_lead_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, [cl.id]))[0];
    const refs = (await db.query(`SELECT rfc_message_id FROM messages WHERE campaign_lead_id = $1 AND rfc_message_id IS NOT NULL ORDER BY created_at`, [cl.id])).map((m: any) => m.rfc_message_id);
    const subject = `Re: ${(lastIn?.subject || cl.first_subject || '').replace(/^re:\s*/i, '')}`;
    const body = mb.signature ? `${text}\n\n${mb.signature}` : text;
    const rfcId = newMessageId(mb.email);
    const raw = buildMime({ fromEmail: mb.email, fromName: mb.from_name, to: cl.email, toName: [cl.first_name, cl.last_name].filter(Boolean).join(' ') || undefined,
      subject, text: body, messageId: rfcId, inReplyTo: lastIn?.rfc_message_id || cl.last_rfc_id, references: refs.join(' ') || null });
    const sent = await ctx.mail.send(mb.email, raw, cl.thread_id);
    await db.query(
      `INSERT INTO messages(campaign_lead_id, lead_id, campaign_id, mailbox_id, direction, kind, status, from_email, to_email, subject, body, rfc_message_id, gmail_message_id, gmail_thread_id)
       VALUES ($1,$2,$3,$4,'out','manual','sent',$5,$6,$7,$8,$9,$10,$11)`,
      [cl.id, cl.lead_id, cl.campaign_id, mb.id, mb.email, cl.email, subject, body, rfcId, sent.id, sent.threadId],
    );
    res.json({ ok: true });
  }));

  // ---------- do-not-contact list ----------
  r.get('/suppressions', wrap(async (req, res) => {
    const search = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    res.json(await db.query(`SELECT * FROM suppressions WHERE ($1::text IS NULL OR value LIKE $1) ORDER BY id DESC LIMIT 500`, [search]));
  }));
  r.post('/suppressions', wrap(async (req, res) => {
    const values: string[] = String(req.body?.values || '').split(/[\s,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
    let added = 0;
    for (const v of values) {
      const kind = v.includes('@') ? 'email' : 'domain';
      if (kind === 'email' && !isValidSyntax(v)) continue;
      await suppress(db, v.replace(/^@/, ''), kind, 'manual');
      added++;
    }
    res.json({ added });
  }));
  r.delete('/suppressions/:id', wrap(async (req, res) => {
    const s = (await db.query(`SELECT * FROM suppressions WHERE id = $1`, [req.params.id]))[0];
    if (s?.reason === 'unsubscribed') return res.status(400).json({ error: 'People who unsubscribed cannot be removed from this list (legal requirement).' });
    await db.query(`DELETE FROM suppressions WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- settings ----------
  r.get('/settings', wrap(async (_req, res) => res.json(await settings(db))));
  r.put('/settings', wrap(async (req, res) => {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!allowed.includes(k)) continue;
      await db.query(`INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, JSON.stringify(v)]);
    }
    res.json(await settings(db));
  }));

  r.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    console.error(err);
    res.status(500).json({ error: err?.message || 'Server error' });
  });

  return r;
}
