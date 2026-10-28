import crypto from 'node:crypto';
import { config } from '../config.js';

const secret = () => config.appSecret || 'dev-secret-not-for-production';

function sign(data: string) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url').slice(0, 22);
}

/** Token for unsubscribe / tracking links: "<kind>.<id>.<sig>". Can't be guessed or altered. */
export function makeToken(kind: 'u' | 'o' | 'c', id: number) {
  const data = `${kind}.${id.toString(36)}`;
  return `${data}.${sign(data)}`;
}

export function readToken(token: string, kind: 'u' | 'o' | 'c'): number | null {
  const [k, id, sig] = token.split('.');
  if (k !== kind || !id || !sig) return null;
  const expected = sign(`${k}.${id}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const n = parseInt(id, 36);
  return Number.isFinite(n) ? n : null;
}

export function sessionValue() {
  const issued = Date.now().toString(36);
  return `${issued}.${sign(`session.${issued}`)}`;
}

export function checkSession(value: string | undefined, maxAgeMs = 30 * 86400000) {
  if (!value) return false;
  const [issued, sig] = value.split('.');
  if (!issued || !sig) return false;
  const expected = sign(`session.${issued}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Date.now() - parseInt(issued, 36) < maxAgeMs;
}

/** "Authorization: Bearer <OUTREACH_API_KEY>" — used by the Claude connector. Off unless the key is set (32+ chars). */
export function validApiKey(header: string | undefined) {
  const key = config.apiKey;
  if (!key || key.length < 32 || !header?.startsWith('Bearer ')) return false;
  const a = crypto.createHash('sha256').update(header.slice(7).trim()).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}
