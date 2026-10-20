import dns from 'node:dns/promises';
import { config } from '../config.js';

export type VerifyResult = { status: 'valid' | 'catch_all' | 'risky' | 'invalid'; detail: string };

export const ROLE_PREFIXES = [
  'info', 'support', 'admin', 'sales', 'contact', 'office', 'help', 'billing', 'accounts', 'enquiries', 'inquiries',
  'noreply', 'no-reply', 'donotreply', 'webmaster', 'hr', 'jobs', 'careers', 'marketing', 'team', 'service', 'hello', 'mail',
  'postmaster', 'abuse', 'privacy', 'legal', 'press', 'media', 'orders', 'reception',
];

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com',
  'getnada.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mailnesia.com',
]);

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(e: string) {
  return e.trim().toLowerCase();
}

export function isValidSyntax(e: string) {
  return EMAIL_RE.test(e) && e.length <= 254;
}

export function isRoleAddress(email: string) {
  const local = email.split('@')[0].toLowerCase();
  return ROLE_PREFIXES.includes(local);
}

const mxCache = new Map<string, boolean>();
async function hasMx(domain: string) {
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  let ok = false;
  try {
    ok = (await dns.resolveMx(domain)).length > 0;
  } catch {
    try {
      ok = (await dns.resolve4(domain)).length > 0; // implicit MX
    } catch {
      ok = false;
    }
  }
  mxCache.set(domain, ok);
  return ok;
}

/** Free check: syntax, disposable, mail server exists. Can't detect a non-existent mailbox at a real domain. */
export async function basicVerify(email: string): Promise<VerifyResult> {
  if (!isValidSyntax(email)) return { status: 'invalid', detail: 'bad syntax' };
  const domain = email.split('@')[1];
  if (DISPOSABLE.has(domain)) return { status: 'invalid', detail: 'disposable domain' };
  if (!(await hasMx(domain))) return { status: 'invalid', detail: 'domain has no mail server' };
  return { status: 'risky', detail: 'basic check only (add a MillionVerifier key for full verification)' };
}

/** Full check via MillionVerifier when a key is configured. */
export async function verifyEmail(email: string): Promise<VerifyResult> {
  const basic = await basicVerify(email);
  if (basic.status === 'invalid' || !config.millionVerifierKey) return basic;
  const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(config.millionVerifierKey)}&email=${encodeURIComponent(email)}&timeout=20`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`MillionVerifier HTTP ${res.status}`);
  const data: any = await res.json();
  if (data.error) throw new Error(`MillionVerifier: ${data.error}`);
  const r = String(data.result || '').toLowerCase();
  if (r === 'ok') return { status: 'valid', detail: 'verified' };
  if (r === 'catch_all') return { status: 'catch_all', detail: 'domain accepts all addresses' };
  if (r === 'invalid' || r === 'disposable') return { status: 'invalid', detail: r };
  return { status: 'risky', detail: r || 'unknown' };
}
