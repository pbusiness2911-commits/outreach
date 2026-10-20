import { JWT } from 'google-auth-library';
import { config } from '../config.js';

// Talks to the Gmail API as each Workspace mailbox using a service account with domain-wide delegation.
// No passwords are stored; the Workspace admin approves the app once (see SETUP.md).

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  internalDate: number;
  headers: Record<string, string>; // lower-case names
  snippet: string;
  text: string;
  labelIds: string[];
}

export interface MailClient {
  send(mailbox: string, raw: string, threadId?: string | null): Promise<{ id: string; threadId: string }>;
  listInbox(mailbox: string, sinceEpochSec: number): Promise<string[]>;
  getMessage(mailbox: string, id: string): Promise<GmailMessageMeta>;
  findByRfcId(mailbox: string, rfcId: string): Promise<{ id: string; threadId: string } | null>;
  check(mailbox: string): Promise<void>;
}

export class GmailError extends Error {
  constructor(message: string, public status: number, public reason?: string) {
    super(message);
  }
  /** Temporary problems: try again later */
  get retryable() {
    return (
      this.status === 429 ||
      this.status >= 500 ||
      ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded'].includes(this.reason || '')
    );
  }
  /** Mailbox can't be used until someone fixes access */
  get authProblem() {
    if (this.retryable) return false;
    return this.status === 401 || this.status === 403 || /unauthorized_client|invalid_grant/i.test(this.message);
  }
}

function decodeB64Url(s: string) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractText(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeB64Url(payload.body.data);
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractText(p);
      if (t && p.mimeType === 'text/plain') return t;
    }
    for (const p of payload.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeB64Url(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (payload.mimeType?.startsWith('message/') && payload.body?.data) return decodeB64Url(payload.body.data);
  return '';
}

export class GmailClient implements MailClient {
  private keys: { client_email: string; private_key: string };
  private clients = new Map<string, JWT>();

  constructor(serviceAccountJson = config.serviceAccountJson) {
    if (!serviceAccountJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
    const parsed = JSON.parse(serviceAccountJson);
    this.keys = { client_email: parsed.client_email, private_key: parsed.private_key };
  }

  private auth(mailbox: string) {
    let c = this.clients.get(mailbox);
    if (!c) {
      c = new JWT({ email: this.keys.client_email, key: this.keys.private_key, scopes: GMAIL_SCOPES, subject: mailbox });
      this.clients.set(mailbox, c);
    }
    return c;
  }

  private async call<T>(mailbox: string, method: string, path: string, body?: unknown): Promise<T> {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}`;
    let res;
    try {
      res = await this.auth(mailbox).request<T>({ url, method: method as any, data: body, retry: false, timeout: 30000 });
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status ?? 0;
      const reason = err?.response?.data?.error?.errors?.[0]?.reason;
      const msg = err?.response?.data?.error?.message || err?.response?.data?.error_description || err?.message || String(err);
      throw new GmailError(`Gmail ${method} ${path.split('?')[0]} failed for ${mailbox}: ${msg}`, status, reason);
    }
    return res.data;
  }

  async send(mailbox: string, raw: string, threadId?: string | null) {
    const body: any = { raw: Buffer.from(raw, 'utf8').toString('base64url') };
    if (threadId) body.threadId = threadId;
    const r = await this.call<{ id: string; threadId: string }>(mailbox, 'POST', 'messages/send', body);
    return { id: r.id, threadId: r.threadId };
  }

  async listInbox(mailbox: string, sinceEpochSec: number) {
    const ids: string[] = [];
    let pageToken: string | undefined;
    const q = encodeURIComponent(`in:inbox after:${Math.floor(sinceEpochSec)}`);
    for (let i = 0; i < 10; i++) {
      const r = await this.call<any>(mailbox, 'GET', `messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const m of r.messages || []) ids.push(m.id);
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return ids;
  }

  async getMessage(mailbox: string, id: string): Promise<GmailMessageMeta> {
    const r = await this.call<any>(mailbox, 'GET', `messages/${id}?format=full`);
    const headers: Record<string, string> = {};
    for (const h of r.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
    return { id: r.id, threadId: r.threadId, internalDate: Number(r.internalDate), headers, snippet: r.snippet || '', text: extractText(r.payload).slice(0, 20000), labelIds: r.labelIds || [] };
  }

  async findByRfcId(mailbox: string, rfcId: string) {
    const q = encodeURIComponent(`rfc822msgid:${rfcId.replace(/[<>]/g, '')}`);
    const r = await this.call<any>(mailbox, 'GET', `messages?q=${q}&includeSpamTrash=true&maxResults=1`);
    const m = r.messages?.[0];
    return m ? { id: m.id, threadId: m.threadId } : null;
  }

  async check(mailbox: string) {
    await this.call(mailbox, 'GET', 'profile');
  }
}

/** Used when DRY_RUN=true or in tests: never sends anything. */
export class FakeMailClient implements MailClient {
  sent: { mailbox: string; raw: string; threadId?: string | null; id: string }[] = [];
  inbox = new Map<string, GmailMessageMeta[]>();
  failNext: GmailError | null = null;
  private n = 0;

  async send(mailbox: string, raw: string, threadId?: string | null) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const id = `fake${++this.n}`;
    this.sent.push({ mailbox, raw, threadId, id });
    return { id, threadId: threadId || `thread${this.n}` };
  }
  async listInbox(mailbox: string) {
    return (this.inbox.get(mailbox) || []).map((m) => m.id);
  }
  async getMessage(mailbox: string, id: string) {
    const m = (this.inbox.get(mailbox) || []).find((x) => x.id === id);
    if (!m) throw new GmailError('not found', 404);
    return m;
  }
  async findByRfcId(mailbox: string, rfcId: string) {
    const hit = this.sent.find((s) => s.mailbox === mailbox && s.raw.includes(`Message-ID: ${rfcId}`));
    return hit ? { id: hit.id, threadId: hit.threadId || hit.id } : null;
  }
  async check() {}
}
