// Classifies incoming mail: bounce, auto-reply, unsubscribe request, or a real reply.

export type InboundKind = 'bounce' | 'auto_reply' | 'reply';

export interface Inbound {
  from: string; // email address, lower-case
  subject: string;
  text: string;
  headers: Record<string, string>;
}

export function parseAddress(v: string | undefined): string {
  if (!v) return '';
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim().toLowerCase();
}

const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon|bounce[s]?)@/i;
const BOUNCE_SUBJECT = /(delivery status notification|undeliver(able|ed)|mail delivery (failed|subsystem)|returned mail|delivery (has )?failed|failure notice|address not found|could not be delivered)/i;

export function classify(m: Inbound): InboundKind {
  if (BOUNCE_FROM.test(m.from) || BOUNCE_SUBJECT.test(m.subject) || m.headers['x-failed-recipients']) return 'bounce';
  const autoSubmitted = (m.headers['auto-submitted'] || '').toLowerCase();
  if (
    (autoSubmitted && autoSubmitted !== 'no') ||
    m.headers['x-autoreply'] ||
    m.headers['x-autorespond'] ||
    /^(auto|automatic)[\s:-]*(reply|response)|out of (the )?office|ooo\b|on vacation|away from (the )?office|autoreply/i.test(m.subject)
  ) {
    return 'auto_reply';
  }
  return 'reply';
}

/** Is this a hard bounce (address doesn't exist) rather than a temporary problem? */
export function isHardBounce(text: string): boolean {
  if (/\b4\.\d\.\d\b|temporar|try again later|mailbox (is )?full|quota exceeded|deferred/i.test(text) && !/\b5\.\d\.\d\b/.test(text)) return false;
  return true;
}

/** Find the failed recipient address in a bounce. */
export function bouncedAddress(m: Inbound, candidates: string[]): string | null {
  const header = m.headers['x-failed-recipients'];
  if (header) return parseAddress(header.split(',')[0]);
  const body = m.text.toLowerCase();
  for (const c of candidates) if (body.includes(c.toLowerCase())) return c.toLowerCase();
  const m2 = m.text.match(/(?:final-recipient|original-recipient):\s*rfc822;\s*([^\s]+)/i);
  return m2 ? m2[1].toLowerCase() : null;
}

/** Reply asks to be removed. Only checks the first lines so quoted text doesn't trigger it. */
export function wantsUnsubscribe(text: string): boolean {
  const fresh = text.split(/\n\s*(?:on .+wrote:|-{2,}\s*original message|from:\s)/i)[0].slice(0, 500);
  return /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (contact|email)|don'?t (contact|email)|opt[\s-]?out)\b/i.test(fresh);
}

/** Strip quoted history from a reply for display. */
export function freshText(text: string): string {
  return text.split(/\n\s*(?:on .+wrote:|-{2,}\s*original message|from:\s.+\n)/i)[0].trim();
}
