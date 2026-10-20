import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import { useLoad, Page, Badge, Alert, Stat, Toggle, Modal } from '../ui';
import { api, fmtDate, pct } from '../api';

const VARS = ['firstName', 'lastName', 'company', 'title', 'city', 'website', 'senderFirstName'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'Europe/London', 'Europe/Paris', 'Australia/Sydney', 'Asia/Kolkata', 'Asia/Dubai'];

export function CampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: c, reload, setData } = useLoad<any>(`/campaigns/${id}`);
  const [tab, setTab] = useState<'sequence' | 'leads' | 'settings' | 'launch'>('sequence');
  if (!c) return <Page title="Campaign">Loading…</Page>;
  const s = c.stats;

  const toggleRun = async () => {
    if (c.status === 'running') {
      await api(`/campaigns/${id}/pause`, { body: {} });
      reload();
    } else setTab('launch');
  };

  return (
    <Page
      title={c.name}
      actions={
        <>
          <Badge value={c.status} />
          <button className={c.status === 'running' ? 'btn-ghost' : 'btn-primary'} onClick={toggleRun}>{c.status === 'running' ? 'Pause' : 'Launch'}</button>
          <button className="btn-ghost" onClick={async () => { const n = prompt('Rename campaign', c.name); if (n) setData(await api(`/campaigns/${id}`, { method: 'PUT', body: { name: n } })); }}>Rename</button>
          <button className="btn-danger" onClick={async () => {
            if (!confirm('Delete this campaign and its stats? Leads stay in your lead list.')) return;
            try { await api(`/campaigns/${id}`, { method: 'DELETE' }); nav('/campaigns'); } catch (e: any) { alert(e.message); }
          }}>Delete</button>
        </>
      }
    >
      {c.status === 'paused' && c.paused_reason && <div className="mb-4"><Alert tone="warn">{c.paused_reason}</Alert></div>}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Leads" value={s.leads} hint={`${s.queued} waiting`} />
        <Stat label="Contacted" value={s.contacted} hint={`${s.sent} emails sent`} />
        <Stat label="Replied" value={s.replied} hint={pct(s.replied, s.contacted)} tone="ok" />
        <Stat label="Interested" value={s.interested} />
        <Stat label="Bounced" value={s.bounced} hint={pct(s.bounced, s.contacted)} tone={s.contacted && s.bounced / s.contacted > 0.02 ? 'bad' : undefined} />
        <Stat label="Unsubscribed" value={s.unsubscribed} />
      </div>
      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {(['sequence', 'leads', 'settings', 'launch'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-4 py-2 text-sm capitalize ${tab === t ? 'border-brand font-medium text-brand' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            {t === 'launch' ? 'Review & launch' : t}
          </button>
        ))}
      </div>
      {tab === 'sequence' && <SequenceEditor campaign={c} onSaved={setData} />}
      {tab === 'leads' && <LeadsTab campaignId={c.id} onChange={reload} />}
      {tab === 'settings' && <SettingsTab campaign={c} onSaved={setData} />}
      {tab === 'launch' && <LaunchTab campaign={c} onChange={reload} />}
    </Page>
  );
}

// ---------------- sequence ----------------
function SequenceEditor({ campaign, onSaved }: { campaign: any; onSaved: (c: any) => void }) {
  const [steps, setSteps] = useState<any[]>(() => structuredClone(campaign.steps));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const focused = useRef<{ el: HTMLTextAreaElement | HTMLInputElement; si: number; vi: number; field: 'subject' | 'body' } | null>(null);

  const update = (fn: (s: any[]) => void) => {
    const copy = structuredClone(steps);
    fn(copy);
    setSteps(copy);
    setDirty(true);
  };
  const insertVar = (v: string) => {
    const f = focused.current;
    if (!f) return;
    const token = `{{${v}}}`;
    const el = f.el;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    update((s) => {
      const cur = s[f.si].variants[f.vi][f.field];
      s[f.si].variants[f.vi][f.field] = cur.slice(0, start) + token + cur.slice(end);
    });
    setTimeout(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); }, 0);
  };
  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const body = steps.map((s) => ({ id: s.id, delay_days: Number(s.delay_days) || 0, new_thread: !!s.new_thread, variants: s.variants.map((v: any) => ({ id: v.id, label: v.label, subject: v.subject, body: v.body, weight: Number(v.weight) || 1, active: v.active !== false })) }));
      const c = await api(`/campaigns/${campaign.id}/sequence`, { method: 'PUT', body });
      onSaved(c);
      setSteps(structuredClone(c.steps));
      setDirty(false);
      setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (e: any) {
      setMsg({ tone: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_220px]">
      <div className="space-y-4">
        {steps.map((step, si) => (
          <div key={step.id ?? `new${si}`} className="card p-5">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-brand-dark px-2.5 py-0.5 text-xs font-semibold text-white">Step {si + 1}</span>
              {si > 0 && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  Wait <input type="number" min={0} max={60} className="input w-16 py-1" value={step.delay_days} onChange={(e) => update((s) => { s[si].delay_days = e.target.value; })} /> days after step {si}
                </label>
              )}
              {si > 0 && (
                <label className="flex items-center gap-1.5 text-sm text-slate-600">
                  <input type="checkbox" className="accent-brand" checked={!!step.new_thread} onChange={(e) => update((s) => { s[si].new_thread = e.target.checked; })} /> New thread (own subject)
                </label>
              )}
              <div className="ml-auto flex gap-2">
                {step.variants.length < 5 && (
                  <button className="text-xs text-brand hover:underline" onClick={() => update((s) => { const base = s[si].variants[0]; s[si].variants.push({ label: String.fromCharCode(65 + s[si].variants.length), subject: base.subject, body: base.body, weight: 1, active: true }); })}>+ A/B variant</button>
                )}
                {steps.length > 1 && <button className="text-xs text-red-600 hover:underline" onClick={() => { if (confirm('Remove this step?')) update((s) => { s.splice(si, 1); }); }}>Remove step</button>}
              </div>
            </div>
            <div className={`grid gap-4 ${step.variants.length > 1 ? 'md:grid-cols-2' : ''}`}>
              {step.variants.map((v: any, vi: number) => (
                <div key={v.id ?? `nv${vi}`} className={`space-y-2 ${step.variants.length > 1 ? 'rounded-lg border border-slate-200 p-3' : ''}`}>
                  {step.variants.length > 1 && (
                    <div className="flex items-center gap-3 text-xs">
                      <span className="font-semibold">Variant {v.label}</span>
                      {v.sent > 0 && <span className="text-slate-500">{v.sent} sent · {v.replies} replies ({pct(v.replies, v.sent)})</span>}
                      <label className="ml-auto flex items-center gap-1"><input type="checkbox" className="accent-brand" checked={v.active !== false} onChange={(e) => update((s) => { s[si].variants[vi].active = e.target.checked; })} /> active</label>
                      <button className="text-red-600" onClick={() => update((s) => { s[si].variants.splice(vi, 1); })}>remove</button>
                    </div>
                  )}
                  {si === 0 || step.new_thread ? (
                    <input className="input" placeholder="Subject" value={v.subject} onFocus={(e) => (focused.current = { el: e.target, si, vi, field: 'subject' })} onChange={(e) => update((s) => { s[si].variants[vi].subject = e.target.value; })} />
                  ) : (
                    <div className="text-xs text-slate-500">Sent as a reply in the same thread (“Re: …”)</div>
                  )}
                  <textarea className="input min-h-44 font-mono text-[13px] leading-relaxed" placeholder="Write your email in plain text…" value={v.body} onFocus={(e) => (focused.current = { el: e.target, si, vi, field: 'body' })} onChange={(e) => update((s) => { s[si].variants[vi].body = e.target.value; })} />
                  {step.variants.length === 1 && v.sent > 0 && <div className="text-xs text-slate-500">{v.sent} sent · {v.opened} opened · {v.replies} replies ({pct(v.replies, v.sent)})</div>}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {steps.length < 15 && <button className="btn-ghost" onClick={() => update((s) => { s.push({ delay_days: 3, new_thread: false, variants: [{ label: 'A', subject: '', body: '', weight: 1, active: true }] }); })}>+ Add follow-up</button>}
          <button className="btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save sequence'}</button>
          <button className="btn-ghost" onClick={async () => { if (dirty) await save(); setPreview(await api(`/campaigns/${campaign.id}/preview`, { body: {} })); }}>Preview</button>
        </div>
        {msg && <Alert tone={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</Alert>}
      </div>
      <div className="space-y-4">
        <div className="card p-4">
          <div className="label">Insert variable</div>
          <div className="flex flex-wrap gap-1.5">
            {VARS.map((v) => <button key={v} className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs hover:bg-slate-200" onClick={() => insertVar(v)}>{v}</button>)}
          </div>
          <p className="mt-3 text-xs text-slate-500">Click in a subject or body first. Add a fallback with <code>{'{{firstName|there}}'}</code>. CSV columns you import can be used too, e.g. <code>{'{{icebreaker}}'}</code>.</p>
        </div>
        <div className="card p-4 text-xs text-slate-600">
          <div className="label">Spintax</div>
          <code>{'{Hi|Hello|Hey}'}</code> picks one at random per lead, so no two emails are identical.
        </div>
        <div className="card p-4 text-xs text-slate-600">
          <div className="label">Deliverability tips</div>
          <ul className="list-disc space-y-1 pl-4">
            <li>Keep step 1 under ~100 words, no links or images.</li>
            <li>Plain text, no attachments.</li>
            <li>Ask a simple question to invite a reply.</li>
          </ul>
        </div>
      </div>
      {preview && (
        <Modal wide title={`Preview for ${preview.lead.email}`} onClose={() => setPreview(null)}>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto">
            {preview.steps.flat().map((p: any, i: number) => (
              <div key={i} className="rounded-lg border border-slate-200 p-4">
                <div className="mb-1 text-xs text-slate-500">Step {p.step}{p.label !== 'A' || preview.steps[p.step - 1].length > 1 ? ` · Variant ${p.label}` : ''} · from {preview.mailbox}</div>
                {p.error ? <Alert tone="error">{p.error}</Alert> : (<><div className="mb-2 font-medium">{p.subject}</div><pre className="whitespace-pre-wrap font-sans text-sm">{p.body}</pre></>)}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------- leads ----------------
const FIELD_OPTIONS = ['email', 'first_name', 'last_name', 'company', 'title', 'phone', 'website', 'linkedin', 'city', 'timezone'];
function guessField(header: string) {
  const h = header.toLowerCase().replace(/[^a-z]/g, '');
  const map: Record<string, string> = { email: 'email', emailaddress: 'email', mail: 'email', firstname: 'first_name', first: 'first_name', fname: 'first_name', givenname: 'first_name', lastname: 'last_name', last: 'last_name', surname: 'last_name', lname: 'last_name', company: 'company', companyname: 'company', organization: 'company', title: 'title', jobtitle: 'title', position: 'title', phone: 'phone', phonenumber: 'phone', website: 'website', url: 'website', companywebsite: 'website', linkedin: 'linkedin', linkedinurl: 'linkedin', city: 'city', timezone: 'timezone', tz: 'timezone' };
  return map[h] || `custom:${header.trim().replace(/\s+/g, '_')}`;
}

function LeadsTab({ campaignId, onChange }: { campaignId: number; onChange: () => void }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const { data, reload } = useLoad<any>(`/campaigns/${campaignId}/leads?page=${page}${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, []);
  const [importing, setImporting] = useState<null | { headers: string[]; rows: any[]; mapping: Record<string, string> }>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [skipOther, setSkipOther] = useState(true);

  const onFile = (file: File) => {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (r) => {
        const headers = r.meta.fields || [];
        setImporting({ headers, rows: r.data as any[], mapping: Object.fromEntries(headers.map((h) => [h, guessField(h)])) });
      },
    });
  };
  const doImport = async () => {
    if (!importing) return;
    const fields = Object.values(importing.mapping);
    if (!fields.includes('email')) return alert('Map one column to "email".');
    setBusy(true);
    try {
      const rows = importing.rows.map((r) => {
        const o: Record<string, string> = {};
        for (const [h, f] of Object.entries(importing.mapping)) {
          if (f === 'skip') continue;
          o[f.startsWith('custom:') ? f.slice(7) : f] = r[h];
        }
        return o;
      });
      const res = await api(`/campaigns/${campaignId}/leads`, { body: { rows, skip_in_other_campaigns: skipOther } });
      setResult(res);
      setImporting(null);
      reload();
      onChange();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="btn-primary cursor-pointer">Import CSV<input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} /></label>
        <select className="input w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
          <option value="">All statuses</option>
          {['queued', 'active', 'completed', 'replied', 'bounced', 'unsubscribed', 'skipped', 'stopped', 'error'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <input className="input w-60" placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <span className="text-sm text-slate-500">{data?.total ?? 0} leads</span>
      </div>
      {result && (
        <Alert tone="ok">
          Added {result.added}. Skipped: {result.duplicates} duplicates, {result.invalid} invalid emails, {result.suppressed} on do-not-contact list, {result.role} role addresses (info@, support@…), {result.in_other_campaign} already in another campaign.
          New leads are verified automatically before sending.
        </Alert>
      )}
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50"><tr><th className="th">Email</th><th className="th">Name</th><th className="th">Company</th><th className="th">Verified</th><th className="th">Status</th><th className="th">Next step</th><th className="th">Mailbox</th><th className="th"></th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data?.rows.map((l: any) => (
              <tr key={l.cl_id}>
                <td className="td">{l.email}</td>
                <td className="td">{[l.first_name, l.last_name].filter(Boolean).join(' ')}</td>
                <td className="td">{l.company}</td>
                <td className="td"><Badge value={l.verification_status} /></td>
                <td className="td"><Badge value={l.status} />{l.status_detail && <div className="max-w-56 truncate text-xs text-slate-500" title={l.status_detail}>{l.status_detail}</div>}</td>
                <td className="td text-xs text-slate-500">{['queued', 'active'].includes(l.status) ? `Step ${l.next_step + 1} · ${fmtDate(l.next_send_at)}` : '—'}</td>
                <td className="td text-xs text-slate-500">{l.mailbox_email || '—'}</td>
                <td className="td text-right">{['queued', 'active'].includes(l.status) && <button className="text-xs text-slate-500 hover:text-red-600" onClick={async () => { await api(`/campaign-leads/${l.cl_id}/stop`, { body: {} }); reload(); }}>Stop</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.rows.length === 0 && <div className="px-6 py-10 text-center text-sm text-slate-500">No leads here yet. Import a CSV with at least an email column.</div>}
      </div>
      {data && data.total > 100 && (
        <div className="flex gap-2">
          <button className="btn-ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <button className="btn-ghost" disabled={(page + 1) * 100 >= data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
      {importing && (
        <Modal wide title={`Import ${importing.rows.length} rows`} onClose={() => setImporting(null)}>
          <p className="mb-3 text-sm text-slate-600">Match each column. Unmatched columns become custom variables you can use in emails.</p>
          <div className="max-h-[55vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th">CSV column</th><th className="th">Example</th><th className="th">Import as</th></tr></thead>
              <tbody>
                {importing.headers.map((h) => (
                  <tr key={h} className="border-t border-slate-100">
                    <td className="td font-medium">{h}</td>
                    <td className="td max-w-48 truncate text-slate-500">{importing.rows[0]?.[h]}</td>
                    <td className="td">
                      <select className="input" value={importing.mapping[h]} onChange={(e) => setImporting({ ...importing, mapping: { ...importing.mapping, [h]: e.target.value } })}>
                        {FIELD_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                        <option value={`custom:${h.trim().replace(/\s+/g, '_')}`}>custom: {`{{${h.trim().replace(/\s+/g, '_')}}}`}</option>
                        <option value="skip">— don't import —</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Toggle checked={skipOther} onChange={setSkipOther} label="Skip people already in another active campaign" />
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setImporting(null)}>Cancel</button>
            <button className="btn-primary" disabled={busy} onClick={doImport}>{busy ? 'Importing…' : 'Import'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------- settings ----------------
function SettingsTab({ campaign, onSaved }: { campaign: any; onSaved: (c: any) => void }) {
  const [f, setF] = useState<any>(campaign);
  const { data: mbs } = useLoad<any[]>('/mailboxes');
  const [selected, setSelected] = useState<number[]>(campaign.mailbox_ids);
  const [msg, setMsg] = useState<any>(null);
  useEffect(() => setF(campaign), [campaign]);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const save = async () => {
    try {
      const fields = ['timezone', 'use_lead_timezone', 'send_days', 'window_start', 'window_end', 'daily_new_leads', 'stop_on_reply', 'stop_on_company_reply', 'stop_on_auto_reply', 'track_opens', 'track_clicks', 'unsubscribe_link', 'send_plain_text', 'allow_catch_all', 'allow_unverified'];
      const body = Object.fromEntries(fields.map((k) => [k, k === 'daily_new_leads' ? Number(f[k]) : f[k]]));
      await api(`/campaigns/${campaign.id}`, { method: 'PUT', body });
      onSaved(await api(`/campaigns/${campaign.id}/mailboxes`, { method: 'PUT', body: { mailbox_ids: selected } }));
      setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (e: any) {
      setMsg({ tone: 'error', text: e.message });
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="card space-y-4 p-5">
        <h3 className="font-semibold">Sending mailboxes</h3>
        <p className="text-xs text-slate-500">Leads are spread across these mailboxes. Each lead always gets all follow-ups from the same mailbox.</p>
        {mbs?.map((m) => (
          <label key={m.id} className="flex items-center gap-3 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-brand" checked={selected.includes(m.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, m.id] : selected.filter((x) => x !== m.id))} />
            <span className="flex-1">{m.email}</span>
            <span className="text-xs text-slate-500">{m.cap_today}/day</span>
            <Badge value={m.status} />
          </label>
        ))}
        <h3 className="pt-2 font-semibold">Schedule</h3>
        <div className="grid grid-cols-2 gap-3">
          <div><span className="label">From</span><input type="time" className="input" value={f.window_start} onChange={(e) => set('window_start', e.target.value)} /></div>
          <div><span className="label">To</span><input type="time" className="input" value={f.window_end} onChange={(e) => set('window_end', e.target.value)} /></div>
        </div>
        <div>
          <span className="label">Days</span>
          <div className="flex gap-1.5">
            {DAYS.map((d, i) => (
              <button key={d} className={`rounded-md px-2.5 py-1 text-xs ${f.send_days.includes(i) ? 'bg-brand text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => set('send_days', f.send_days.includes(i) ? f.send_days.filter((x: number) => x !== i) : [...f.send_days, i].sort())}>{d}</button>
            ))}
          </div>
        </div>
        <div>
          <span className="label">Time zone (when a lead has none)</span>
          <select className="input" value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>{[...new Set([f.timezone, ...TIMEZONES])].map((t) => <option key={t}>{t}</option>)}</select>
        </div>
        <Toggle checked={f.use_lead_timezone} onChange={(v) => set('use_lead_timezone', v)} label="Send in each lead's own time zone" hint="Uses the lead's timezone column when present" />
        <div><span className="label">New leads per day (campaign limit)</span><input type="number" className="input w-32" min={1} value={f.daily_new_leads} onChange={(e) => set('daily_new_leads', e.target.value)} /></div>
      </div>
      <div className="card space-y-1 p-5">
        <h3 className="mb-2 font-semibold">Stopping rules</h3>
        <Toggle checked={f.stop_on_reply} onChange={(v) => set('stop_on_reply', v)} label="Stop when the lead replies" hint="Also stops them in every other campaign" />
        <Toggle checked={f.stop_on_company_reply} onChange={(v) => set('stop_on_company_reply', v)} label="Stop for the whole company when anyone there replies" hint="Ignored for Gmail/Yahoo/Outlook addresses" />
        <Toggle checked={f.stop_on_auto_reply} onChange={(v) => set('stop_on_auto_reply', v)} label="Stop on out-of-office auto-replies" />
        <h3 className="mb-2 pt-4 font-semibold">List quality</h3>
        <Toggle checked={f.allow_catch_all} onChange={(v) => set('allow_catch_all', v)} label="Send to catch-all domains" hint="Riskier: these can't be fully verified" />
        <Toggle checked={f.allow_unverified} onChange={(v) => set('allow_unverified', v)} label="Send to 'risky' / unknown results" hint="Not recommended" />
        <h3 className="mb-2 pt-4 font-semibold">Deliverability</h3>
        <Toggle checked={f.send_plain_text} onChange={(v) => set('send_plain_text', v)} label="Send as plain text" hint="Recommended for cold email" />
        <Toggle checked={f.unsubscribe_link} onChange={(v) => set('unsubscribe_link', v)} label="Add an unsubscribe line to the email" hint="The one-click unsubscribe header Gmail requires is always included" />
        <Toggle checked={f.track_opens} onChange={(v) => set('track_opens', v)} label="Track opens" hint="Adds a tracking pixel; can hurt inbox placement. Off is safer." />
        <Toggle checked={f.track_clicks} onChange={(v) => set('track_clicks', v)} label="Track link clicks" hint="Rewrites links; can hurt inbox placement. Off is safer." />
      </div>
      <div className="lg:col-span-2 flex items-center gap-3">
        <button className="btn-primary" onClick={save}>Save settings</button>
        {msg && <span className={`text-sm ${msg.tone === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ---------------- launch ----------------
function LaunchTab({ campaign, onChange }: { campaign: any; onChange: () => void }) {
  const { data: checks, reload } = useLoad<any>(`/campaigns/${campaign.id}/checks`);
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="card space-y-3 p-5">
        <h3 className="font-semibold">Pre-launch checks</h3>
        {!checks ? 'Checking…' : (
          <>
            {checks.errors.map((e: string) => <Alert key={e} tone="error">{e}</Alert>)}
            {checks.warnings.map((w: string) => <Alert key={w} tone="warn">{w}</Alert>)}
            {!checks.errors.length && !checks.warnings.length && <Alert tone="ok">Everything looks good.</Alert>}
          </>
        )}
        <div className="flex gap-2 pt-2">
          {campaign.status !== 'running' ? (
            <button className="btn-primary" disabled={busy || !checks || checks.errors.length > 0} onClick={async () => {
              setBusy(true);
              try { await api(`/campaigns/${campaign.id}/launch`, { body: {} }); onChange(); setMsg({ tone: 'ok', text: 'Launched. Sending starts within the schedule window.' }); } catch (e: any) { setMsg({ tone: 'error', text: e.message }); } finally { setBusy(false); reload(); }
            }}>Launch campaign</button>
          ) : (
            <span className="text-sm text-green-700">This campaign is running.</span>
          )}
          <button className="btn-ghost" onClick={reload}>Re-check</button>
        </div>
        {msg && <Alert tone={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</Alert>}
      </div>
      <div className="card space-y-3 p-5">
        <h3 className="font-semibold">Send a test email</h3>
        <p className="text-sm text-slate-500">Sends step 1 (variant A) to you, personalized with the first lead in the list.</p>
        <input className="input" placeholder="you@yourdomain.com" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn-ghost" disabled={!to} onClick={async () => {
          try { await api(`/campaigns/${campaign.id}/test-email`, { body: { to } }); setMsg({ tone: 'ok', text: `Test sent to ${to}.` }); } catch (e: any) { setMsg({ tone: 'error', text: e.message }); }
        }}>Send test</button>
      </div>
    </div>
  );
}
