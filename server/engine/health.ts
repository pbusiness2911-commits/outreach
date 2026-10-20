import { Ctx, logEvent, settings } from './context.js';
import { checkDomain } from '../lib/dnscheck.js';
import { verifyEmail } from '../lib/verify.js';

/** Pauses mailboxes and campaigns automatically when bounce rates get dangerous. */
export async function healthTick(ctx: Ctx) {
  const cfg = await settings(ctx.db);
  const since = new Date(ctx.now().getTime() - 7 * 86400000);
  const limit = cfg.bounce_pause_percent / 100;

  const mailboxes = await ctx.db.query(
    `SELECT mb.id, mb.email,
            (SELECT count(*)::int FROM messages WHERE mailbox_id = mb.id AND direction='out' AND status='sent' AND created_at > $1) AS sent,
            (SELECT count(*)::int FROM messages WHERE mailbox_id = mb.id AND direction='in' AND kind='bounce' AND created_at > $1) AS bounces
       FROM mailboxes mb WHERE mb.status = 'active'`,
    [since],
  );
  for (const mb of mailboxes) {
    if (mb.sent >= cfg.bounce_min_sends && mb.bounces / mb.sent > limit) {
      const pct = ((mb.bounces / mb.sent) * 100).toFixed(1);
      await ctx.db.query(`UPDATE mailboxes SET status = 'paused', paused_reason = $2 WHERE id = $1`, [mb.id, `Auto-paused: ${pct}% bounces in 7 days`]);
      await logEvent(ctx.db, 'error', 'health', `Paused ${mb.email}: ${pct}% bounce rate (${mb.bounces}/${mb.sent}) over 7 days`, { mailbox_id: mb.id });
    }
  }

  const campaigns = await ctx.db.query(
    `SELECT c.id, c.name,
            (SELECT count(*)::int FROM messages WHERE campaign_id = c.id AND direction='out' AND status='sent' AND created_at > $1) AS sent,
            (SELECT count(*)::int FROM messages WHERE campaign_id = c.id AND direction='in' AND kind='bounce' AND created_at > $1) AS bounces
       FROM campaigns c WHERE c.status = 'running'`,
    [since],
  );
  for (const c of campaigns) {
    if (c.sent >= cfg.bounce_min_sends && c.bounces / c.sent > limit) {
      const pct = ((c.bounces / c.sent) * 100).toFixed(1);
      await ctx.db.query(`UPDATE campaigns SET status = 'paused', paused_reason = $2 WHERE id = $1`, [c.id, `Auto-paused: ${pct}% bounces. Clean the list before resuming.`]);
      await logEvent(ctx.db, 'error', 'health', `Paused campaign "${c.name}": ${pct}% bounce rate`, { campaign_id: c.id });
    }
  }

  // Campaigns with nothing left to send are marked completed
  await ctx.db.query(
    `UPDATE campaigns c SET status = 'completed' WHERE status = 'running'
       AND EXISTS (SELECT 1 FROM campaign_leads WHERE campaign_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM campaign_leads WHERE campaign_id = c.id AND status IN ('queued','active','sending'))`,
  );
}

/** Checks SPF / DKIM / DMARC / MX for each sending domain once every 12 hours. */
export async function dnsTick(ctx: Ctx, force = false) {
  const cfg = await settings(ctx.db);
  const cutoff = new Date(ctx.now().getTime() - 12 * 3600000);
  const mbs = await ctx.db.query(`SELECT * FROM mailboxes WHERE $1 OR dns_checked_at IS NULL OR dns_checked_at < $2`, [force, cutoff]);
  const byDomain = new Map<string, any[]>();
  for (const mb of mbs) {
    const d = mb.email.split('@')[1];
    byDomain.set(d, [...(byDomain.get(d) || []), mb]);
  }
  for (const [domain, list] of byDomain) {
    let status;
    try {
      status = await checkDomain(domain);
    } catch (err: any) {
      await logEvent(ctx.db, 'warn', 'dns', `DNS check failed for ${domain}: ${err.message}`);
      continue;
    }
    for (const mb of list) {
      await ctx.db.query(`UPDATE mailboxes SET dns_status = $2, dns_checked_at = $3 WHERE id = $1`, [mb.id, JSON.stringify(status), ctx.now()]);
      if (!status.ok && cfg.require_dns && mb.status === 'active') {
        const missing = (['spf', 'dkim', 'dmarc', 'mx'] as const).filter((k) => !status[k].ok).map((k) => k.toUpperCase()).join(', ');
        await ctx.db.query(`UPDATE mailboxes SET status = 'paused', paused_reason = $2 WHERE id = $1`, [mb.id, `DNS problem: ${missing} not set up correctly`]);
        await logEvent(ctx.db, 'error', 'dns', `Paused ${mb.email}: ${missing} missing or wrong on ${domain}`, { mailbox_id: mb.id });
      }
    }
  }
}

/** Verifies leads that are waiting in a draft or running campaign, a few at a time. */
export async function verifyTick(ctx: Ctx, batch = 15) {
  const leads = await ctx.db.query(
    `SELECT DISTINCT l.id, l.email FROM leads l JOIN campaign_leads cl ON cl.lead_id = l.id JOIN campaigns c ON c.id = cl.campaign_id
      WHERE l.verification_status = 'unverified' AND c.status IN ('draft','running','paused') AND cl.status = 'queued'
      LIMIT $1`,
    [batch],
  );
  for (const l of leads) {
    try {
      const r = await verifyEmail(l.email);
      await ctx.db.query(`UPDATE leads SET verification_status = $2, verification_detail = $3, verified_at = $4 WHERE id = $1`, [l.id, r.status, r.detail, ctx.now()]);
    } catch (err: any) {
      await logEvent(ctx.db, 'warn', 'verify', `Could not verify ${l.email}: ${err.message}`, { lead_id: l.id });
      return; // stop this round (API down / out of credits); try again next tick
    }
  }
}
