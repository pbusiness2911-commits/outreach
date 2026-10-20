import dns from 'node:dns/promises';

export interface DnsStatus {
  domain: string;
  spf: { ok: boolean; detail: string };
  dkim: { ok: boolean; detail: string };
  dmarc: { ok: boolean; detail: string };
  mx: { ok: boolean; detail: string };
  ok: boolean; // all required records pass
}

async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((r) => r.join(''));
  } catch {
    return [];
  }
}

/** Checks the records Google Workspace sending needs. DKIM selector "google" is Workspace's default. */
export async function checkDomain(domain: string, dkimSelector = 'google'): Promise<DnsStatus> {
  const spfRecords = (await txt(domain)).filter((r) => r.toLowerCase().startsWith('v=spf1'));
  const spf =
    spfRecords.length === 0
      ? { ok: false, detail: 'No SPF record' }
      : spfRecords.length > 1
        ? { ok: false, detail: 'More than one SPF record (only one allowed)' }
        : spfRecords[0].includes('_spf.google.com')
          ? { ok: true, detail: spfRecords[0] }
          : { ok: false, detail: `SPF does not include _spf.google.com: ${spfRecords[0]}` };

  const dkimRec = (await txt(`${dkimSelector}._domainkey.${domain}`)).find((r) => /v=DKIM1|p=/i.test(r));
  const dkim = dkimRec ? { ok: true, detail: `${dkimSelector}._domainkey found` } : { ok: false, detail: `No DKIM record at ${dkimSelector}._domainkey` };

  const dmarcRec = (await txt(`_dmarc.${domain}`)).find((r) => r.toLowerCase().startsWith('v=dmarc1'));
  const dmarc = dmarcRec ? { ok: true, detail: dmarcRec } : { ok: false, detail: 'No DMARC record' };

  let mx = { ok: false, detail: 'No MX record' };
  try {
    const recs = await dns.resolveMx(domain);
    const google = recs.some((r) => /google\.com$|googlemail\.com$/i.test(r.exchange));
    mx = recs.length ? { ok: google, detail: google ? 'Google MX' : `MX is not Google: ${recs.map((r) => r.exchange).join(', ')}` } : mx;
  } catch {}

  return { domain, spf, dkim, dmarc, mx, ok: spf.ok && dkim.ok && dmarc.ok && mx.ok };
}
