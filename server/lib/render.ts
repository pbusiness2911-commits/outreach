// Personalization: {{firstName}}, {{company|your team}} (fallback after |), and spintax {Hi|Hello|Hey}.

export type LeadVars = Record<string, string | null | undefined>;

const ALIASES: Record<string, string> = {
  firstname: 'first_name', first_name: 'first_name', name: 'first_name',
  lastname: 'last_name', last_name: 'last_name',
  company: 'company', companyname: 'company', company_name: 'company',
  email: 'email', title: 'title', jobtitle: 'title', phone: 'phone', website: 'website',
  linkedin: 'linkedin', city: 'city', domain: 'domain',
  sendername: 'sender_name', sender_name: 'sender_name', senderfirstname: 'sender_first_name', sender_first_name: 'sender_first_name',
};

function normalizeKey(k: string) {
  const key = k.trim().replace(/^sender\./i, 'sender_').replace(/[\s-]/g, '_').toLowerCase();
  return ALIASES[key.replace(/_/g, '')] ?? ALIASES[key] ?? key;
}

export class MissingVariableError extends Error {
  constructor(public variable: string) {
    super(`Missing value for {{${variable}}} and no fallback given`);
  }
}

/** Replace {{var}} / {{var|fallback}}. Throws if a variable has no value and no fallback, so a broken email is never sent. */
export function fillVariables(text: string, vars: LeadVars): string {
  const lookup: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (v != null) lookup[normalizeKey(k)] = String(v);
  return text.replace(/\{\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}\}/g, (_m, name: string, fallback?: string) => {
    const value = (lookup[normalizeKey(name)] ?? '').trim();
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    throw new MissingVariableError(name.trim());
  });
}

/** Spintax {a|b|c}, nested allowed. Uses the given random so a lead always gets a stable choice. */
export function spin(text: string, rand: () => number = Math.random): string {
  let out = text;
  for (let i = 0; i < 20; i++) {
    const next = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, inner: string) => {
      const opts = inner.split('|');
      return opts[Math.floor(rand() * opts.length)];
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Deterministic random generator seeded by a string (stable per lead + step). */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Variables first (so a lead's value containing "|" isn't spun), then spintax. */
export function renderTemplate(text: string, vars: LeadVars, seed: string): string {
  // protect {{...}} from spintax by filling them first, but spin needs to skip filled values: fill into placeholders
  const values: string[] = [];
  const withPlaceholders = text.replace(/\{\{[^}]*\}\}/g, (m) => {
    values.push(fillVariables(m, vars));
    return `\u0000${values.length - 1}\u0000`;
  });
  const spun = spin(withPlaceholders, seededRandom(seed));
  return spun.replace(/\u0000(\d+)\u0000/g, (_m, i) => values[Number(i)]);
}

export function leadVars(lead: any, mailbox: { from_name?: string; email: string }): LeadVars {
  const senderName = mailbox.from_name || '';
  return {
    first_name: lead.first_name, last_name: lead.last_name, company: lead.company, email: lead.email,
    title: lead.title, phone: lead.phone, website: lead.website, linkedin: lead.linkedin, city: lead.city,
    domain: lead.domain, sender_name: senderName, sender_first_name: senderName.split(' ')[0],
    ...(lead.custom || {}),
  };
}

/** Finds variables in a template that have no fallback; used to warn before launch. */
export function requiredVariables(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g)) if (m[2] === undefined) out.add(m[1].trim());
  return [...out];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text -> minimal HTML (paragraphs + line breaks, links clickable). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<div>${escapeHtml(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div><div><br></div>`)
    .join('');
}
