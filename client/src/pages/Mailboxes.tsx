import { useState } from 'react';
import { useLoad, Page, Badge, Alert, Modal, Toggle, Empty } from '../ui';
import { api, fmtDate, pct } from '../api';

function DnsCell({ s }: { s: any }) {
  if (!s) return <span className="text-xs text-slate-400">not checked</span>;
  return (
    <div className="flex gap-1">
      {(['spf', 'dkim', 'dmarc', 'mx'] as const).map((k) => (
        <span key={k} title={s[k].detail} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${s[k].ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{k}{s[k].ok ? ' ✓' : ' ✗'}</span>
      ))}
    </div>
  );
}

export function Mailboxes() {
  const { data, reload, setData } = useLoad<any[]>('/mailboxes');
  const [edit, setEdit] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<any>(null);
  const act = async (path: string) => {
    setMsg(null);
    try { await api(path, { body: {} }); reload(); } catch (e: any) { setMsg({ tone: 'error', text: e.message }); }
  };
  return (
    <Page title="Mailboxes" actions={<>
      <button className="btn-ghost" onClick={async () => setData(await api('/dns/check', { body: {} }))}>Check DNS</button>
      <button className="btn-primary" onClick={() => { setEdit({ email: '', from_name: '', signature: '', daily_limit: 30, ramp_enabled: true, ramp_start: 5, ramp_increment: 2, min_gap_seconds: 240, max_gap_seconds: 600 }); setAdding(true); }}>+ Add mailbox</button>
    </>}>
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!data ? 'Loading…' : data.length === 0 ? <Empty>No mailboxes yet. Add your Google Workspace addresses (see SETUP.md for the one-time Google setup).</Empty> : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50"><tr><th className="th">Mailbox</th><th className="th">Status</th><th className="th">Today</th><th className="th">7 days</th><th className="th">DNS</th><th className="th">Inbox checked</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((m) => (
                <tr key={m.id} className="align-top">
                  <td className="td"><div className="font-medium">{m.email}</div><div className="text-xs text-slate-500">{m.from_name}</div></td>
                  <td className="td"><Badge value={m.status} />{m.paused_reason && <div className="mt-1 max-w-56 text-xs text-amber-700">{m.paused_reason}</div>}</td>
                  <td className="td">{m.sent_24h} / {m.cap_today}<div className="text-xs text-slate-500">{m.ramp_enabled && m.cap_today < m.daily_limit ? `ramping to ${m.daily_limit}` : `limit ${m.daily_limit}`}</div></td>
                  <td className="td text-xs">{m.sent_7d} sent<br /><span className={m.sent_7d && m.bounces_7d / m.sent_7d > 0.02 ? 'text-red-600' : ''}>{m.bounces_7d} bounces ({pct(m.bounces_7d, m.sent_7d)})</span><br />{m.replies_7d} replies</td>
                  <td className="td"><DnsCell s={m.dns_status} /></td>
                  <td className="td text-xs text-slate-500">{fmtDate(m.last_synced_at)}</td>
                  <td className="td whitespace-nowrap text-right text-xs">
                    <button className="mr-3 text-slate-500 hover:text-brand" onClick={() => { setEdit(m); setAdding(false); }}>Edit</button>
                    {m.status === 'active'
                      ? <button className="mr-3 text-slate-500 hover:text-amber-700" onClick={() => act(`/mailboxes/${m.id}/pause`)}>Pause</button>
                      : <button className="mr-3 text-brand hover:underline" onClick={() => act(`/mailboxes/${m.id}/resume`)}>Resume</button>}
                    <button className="mr-3 text-slate-500 hover:text-brand" onClick={async () => { try { await api(`/mailboxes/${m.id}/test`, { body: {} }); setMsg({ tone: 'ok', text: `${m.email}: connection OK` }); } catch (e: any) { setMsg({ tone: 'error', text: e.message }); } }}>Test</button>
                    <button className="text-slate-500 hover:text-red-600" onClick={async () => { if (!confirm(`Remove ${m.email}?`)) return; try { await api(`/mailboxes/${m.id}`, { method: 'DELETE' }); reload(); } catch (e: any) { setMsg({ tone: 'error', text: e.message }); } }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Alert tone="info"><b>Safe limits:</b> 20–30 cold emails per mailbox per day. New mailboxes ramp up automatically.</Alert>
        <Alert tone="info"><b>Auto-pause:</b> a mailbox stops by itself if bounces pass the limit in Settings, Gmail access breaks, or DNS records are wrong.</Alert>
        <Alert tone="info"><b>Warm-up:</b> keep lemwarm (or another warm-up tool) running on these mailboxes. This app doesn't replace it.</Alert>
      </div>
      {edit && <MailboxForm initial={edit} adding={adding} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </Page>
  );
}

function MailboxForm({ initial, adding, onClose, onSaved }: { initial: any; adding: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const num = (k: string) => (e: any) => set(k, Number(e.target.value));
  return (
    <Modal title={adding ? 'Add mailbox' : `Edit ${initial.email}`} onClose={onClose}>
      <div className="space-y-3">
        {adding && <div><span className="label">Google Workspace email</span><input className="input" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="tyler@yourdomain.com" /></div>}
        <div><span className="label">From name</span><input className="input" value={f.from_name} onChange={(e) => set('from_name', e.target.value)} placeholder="Tyler Brooks" /></div>
        <div><span className="label">Signature (plain text)</span><textarea className="input min-h-20" value={f.signature} onChange={(e) => set('signature', e.target.value)} placeholder={'Tyler\nConversion Labs'} /></div>
        <div className="grid grid-cols-3 gap-3">
          <div><span className="label">Daily limit</span><input type="number" className="input" min={1} max={100} value={f.daily_limit} onChange={num('daily_limit')} /></div>
          <div><span className="label">Min gap (sec)</span><input type="number" className="input" min={60} value={f.min_gap_seconds} onChange={num('min_gap_seconds')} /></div>
          <div><span className="label">Max gap (sec)</span><input type="number" className="input" min={60} value={f.max_gap_seconds} onChange={num('max_gap_seconds')} /></div>
        </div>
        <Toggle checked={f.ramp_enabled} onChange={(v) => set('ramp_enabled', v)} label="Gradual ramp-up" hint="Start low and add a few emails per day until the daily limit" />
        {f.ramp_enabled && (
          <div className="grid grid-cols-2 gap-3">
            <div><span className="label">Start at (per day)</span><input type="number" className="input" min={1} value={f.ramp_start} onChange={num('ramp_start')} /></div>
            <div><span className="label">Add per day</span><input type="number" className="input" min={1} value={f.ramp_increment} onChange={num('ramp_increment')} /></div>
          </div>
        )}
        {f.daily_limit > 40 && <Alert tone="warn">More than 40 cold emails a day from one mailbox raises spam risk. 20–30 is safer.</Alert>}
        {err && <Alert tone="error">{err}</Alert>}
        <div className="flex justify-end gap-2 pt-2">
          {!adding && <button className="btn-ghost mr-auto" onClick={async () => { await api(`/mailboxes/${initial.id}/restart-ramp`, { body: {} }); onSaved(); }}>Restart ramp-up</button>}
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={async () => {
            setBusy(true); setErr('');
            try {
              const body = { from_name: f.from_name, signature: f.signature, daily_limit: f.daily_limit, ramp_enabled: f.ramp_enabled, ramp_start: f.ramp_start, ramp_increment: f.ramp_increment, min_gap_seconds: f.min_gap_seconds, max_gap_seconds: f.max_gap_seconds };
              if (adding) await api('/mailboxes', { body: { ...body, email: f.email } });
              else await api(`/mailboxes/${initial.id}`, { method: 'PATCH', body });
              onSaved();
            } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
          }}>{busy ? 'Saving…' : adding ? 'Connect & add' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}
