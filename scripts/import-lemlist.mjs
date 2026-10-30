// Import a lemlist "Export as CSV" into a campaign of this app.
//   node scripts/import-lemlist.mjs <file.csv> <campaignId> [--dry]
// Uses OUTREACH_URL and OUTREACH_API_KEY from your environment (the same ones the Claude connector uses).
// Adds the columns the converted sequence needs (subject_name, biz_plural, in_city, ...), guesses each lead's
// time zone from the phone country code, and leaves out leads lemlist already marked replied/bounced/unsubscribed.
import fs from 'node:fs';
import Papa from 'papaparse';

const [file, campaignId, flag] = process.argv.slice(2);
const dry = flag === '--dry';
if (!file || !campaignId) throw new Error('Usage: node scripts/import-lemlist.mjs <file.csv> <campaignId> [--dry]');
const url = (process.env.OUTREACH_URL || '').replace(/\/$/, '');
const key = process.env.OUTREACH_API_KEY || '';
if (!dry && (!url || !key)) throw new Error('Set OUTREACH_URL and OUTREACH_API_KEY first.');

const { data, errors } = Papa.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
if (errors.length) console.warn(`CSV warnings: ${errors.length} (first: ${errors[0].message})`);

const pick = (r, ...names) => {
  for (const n of names) for (const k of Object.keys(r)) if (k.toLowerCase() === n.toLowerCase() && String(r[k]).trim()) return String(r[k]).trim();
  return '';
};

// Country code -> a representative time zone (sending window is 9-17 in the lead's zone)
const TZ = [
  ['+61', 'Australia/Sydney'], ['+64', 'Pacific/Auckland'], ['+44', 'Europe/London'], ['+353', 'Europe/Dublin'],
  ['+1', 'America/New_York'], ['+91', 'Asia/Kolkata'], ['+971', 'Asia/Dubai'], ['+65', 'Asia/Singapore'],
];
const AU_STATE_TZ = { WA: 'Australia/Perth', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide', NT: 'Australia/Darwin', TAS: 'Australia/Hobart', NSW: 'Australia/Sydney', VIC: 'Australia/Melbourne', ACT: 'Australia/Sydney' };
function timezoneFor(phone, city) {
  const p = phone.replace(/[^\d+]/g, '');
  const hit = TZ.find(([cc]) => p.startsWith(cc));
  if (!hit) return '';
  if (hit[0] === '+61') {
    const st = city.match(/\b(WA|QLD|SA|NT|TAS|NSW|VIC|ACT)\b/)?.[1];
    if (st) return AU_STATE_TZ[st];
  }
  return hit[1];
}

const SKIP_STATES = /replied|bounced|unsubscribed|interested|notinterested|failed|paused/i;
const counts = { rows: data.length, kept: 0, skipped_state: 0, no_email: 0, tz: {} };
const rows = [];
for (const r of data) {
  const email = pick(r, 'email');
  if (!email) { counts.no_email++; continue; }
  const state = pick(r, 'lastState', 'status');
  if (state && SKIP_STATES.test(state)) { counts.skipped_state++; continue; }
  const firstName = pick(r, 'firstName', 'first_name');
  const company = pick(r, 'companyName', 'company');
  const city = pick(r, 'city');
  const type = pick(r, 'businessType');
  const plural = pick(r, 'businessTypePlural') || (type ? `${type}s` : '');
  const phone = pick(r, 'phone');
  const tz = timezoneFor(phone, city);
  counts.tz[tz || 'campaign default (New York)'] = (counts.tz[tz || 'campaign default (New York)'] || 0) + 1;
  rows.push({
    email, first_name: firstName, last_name: pick(r, 'lastName', 'last_name'), company, city, phone,
    website: pick(r, 'companyDomain', 'website'), linkedin: pick(r, 'linkedinUrl', 'linkedin'), timezone: tz,
    businessType: type, biz_plural: plural, idealCustomer: pick(r, 'idealCustomer'),
    subject_name: firstName || company || 'there',
    in_city: city ? `in ${city}` : '', city_nearby: city ? `in ${city}` : '', city_near_you: city ? `in ${city}` : '',
  });
}
counts.kept = rows.length;
console.log(JSON.stringify(counts, null, 2));
if (dry) process.exit(0);

const total = { added: 0, duplicates: 0, invalid: 0, suppressed: 0, role: 0, in_other_campaign: 0 };
// Re-sending a batch is safe: leads already in the campaign count as duplicates.
const BATCH = 200;
for (let i = (Number(process.env.START_BATCH || 1) - 1) * BATCH; i < rows.length; i += BATCH) {
  let out;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${url}/api/campaigns/${campaignId}/leads`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ rows: rows.slice(i, i + BATCH), skip_in_other_campaigns: true }),
      });
      out = await res.json();
      if (!res.ok) throw new Error(out.error || String(res.status));
      break;
    } catch (err) {
      if (attempt >= 8) throw new Error(`Batch ${i / BATCH + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  for (const k of Object.keys(total)) total[k] += out[k] || 0;
  console.log(`batch ${i / BATCH + 1}: +${out.added} (dup ${out.duplicates || 0}, role ${out.role || 0}, invalid ${out.invalid || 0}, blocked ${out.suppressed || 0})`);
}
console.log('IMPORT RESULT', JSON.stringify(total));
