import crypto from 'node:crypto';

export interface OutgoingEmail {
  fromEmail: string;
  fromName?: string;
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html?: string; // when omitted, the email is plain text only (best for deliverability)
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  unsubscribeUrl?: string | null;
  unsubscribeMailto?: string | null;
}

export function newMessageId(fromEmail: string) {
  const domain = fromEmail.split('@')[1] || 'localhost';
  return `<${crypto.randomUUID().replace(/-/g, '')}@${domain}>`;
}

/** RFC 2047 encode a header value only when it has non-ASCII characters. */
function encodeHeader(v: string) {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function address(email: string, name?: string) {
  if (!name) return email;
  const n = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}"` : encodeHeader(name);
  return `${n} <${email}>`;
}

function b64Lines(s: string) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

/** Builds a raw RFC 5322 message. Plain text unless html is given (then multipart/alternative). */
export function buildMime(e: OutgoingEmail): string {
  for (const v of [e.to, e.fromEmail, e.subject]) if (/[\r\n]/.test(v)) throw new Error('Header injection blocked');
  const headers = [
    `From: ${address(e.fromEmail, e.fromName)}`,
    `To: ${address(e.to, e.toName)}`,
    `Subject: ${encodeHeader(e.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${e.messageId}`,
    'MIME-Version: 1.0',
  ];
  if (e.inReplyTo) headers.push(`In-Reply-To: ${e.inReplyTo}`);
  if (e.references) headers.push(`References: ${e.references}`);
  const unsub = [e.unsubscribeMailto && `<mailto:${e.unsubscribeMailto}?subject=unsubscribe>`, e.unsubscribeUrl && `<${e.unsubscribeUrl}>`].filter(Boolean);
  if (unsub.length) headers.push(`List-Unsubscribe: ${unsub.join(', ')}`);
  if (e.unsubscribeUrl) headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');

  if (!e.html) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${b64Lines(e.text)}`;
  }
  const boundary = `b_${crypto.randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(e.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(e.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
