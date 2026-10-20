import type { Db, Queryable } from '../db/db.js';
import type { MailClient } from '../lib/gmail.js';

export interface Ctx {
  db: Db;
  mail: MailClient;
  now: () => Date;
  publicUrl: string;
  /** When there's no MillionVerifier key, basic-checked ("risky") leads are allowed */
  fullVerification: boolean;
}

export async function logEvent(
  q: Queryable,
  level: 'info' | 'warn' | 'error',
  type: string,
  message: string,
  refs: { mailbox_id?: number | null; campaign_id?: number | null; lead_id?: number | null } = {},
) {
  await q.query(`INSERT INTO events(level, type, message, mailbox_id, campaign_id, lead_id) VALUES ($1,$2,$3,$4,$5,$6)`, [
    level, type, message, refs.mailbox_id ?? null, refs.campaign_id ?? null, refs.lead_id ?? null,
  ]);
  if (level !== 'info') console[level === 'error' ? 'error' : 'warn'](`[${type}] ${message}`);
}

export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'comcast.net',
  'verizon.net', 'att.net', 'sbcglobal.net', 'optonline.net', 'bellsouth.net', 'cox.net',
]);

export async function isSuppressed(q: Queryable, email: string): Promise<string | null> {
  const domain = email.split('@')[1];
  const rows = await q.query<{ reason: string }>(`SELECT reason FROM suppressions WHERE value = $1 OR (kind = 'domain' AND value = $2) LIMIT 1`, [email, domain]);
  return rows[0]?.reason ?? null;
}

export async function suppress(q: Queryable, value: string, kind: 'email' | 'domain', reason: string) {
  await q.query(`INSERT INTO suppressions(value, kind, reason) VALUES ($1,$2,$3) ON CONFLICT (value) DO NOTHING`, [value.toLowerCase(), kind, reason]);
  // stop every running sequence for this address / domain
  const where = kind === 'email' ? `l.email = $1` : `l.domain = $1`;
  await q.query(
    `UPDATE campaign_leads cl SET status = $2, status_detail = $3
       FROM leads l WHERE l.id = cl.lead_id AND ${where} AND cl.status IN ('queued','active')`,
    [value.toLowerCase(), reason === 'bounced' ? 'bounced' : reason === 'unsubscribed' ? 'unsubscribed' : 'stopped', `suppressed: ${reason}`],
  );
}

export async function getSetting<T>(q: Queryable, key: string, fallback: T): Promise<T> {
  const r = await q.query<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return r.length ? r[0].value : fallback;
}

export const DEFAULT_SETTINGS = {
  block_role_addresses: true,
  require_dns: true,
  bounce_pause_percent: 3,
  bounce_min_sends: 30,
};

export async function settings(q: Queryable) {
  const rows = await q.query<{ key: string; value: any }>(`SELECT key, value FROM settings`);
  const out: Record<string, any> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out as typeof DEFAULT_SETTINGS;
}
