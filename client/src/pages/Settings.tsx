import { useEffect, useState } from 'react';
import { useLoad, Page, Toggle, Alert } from '../ui';
import { api } from '../api';

export function Settings() {
  const { data } = useLoad<any>('/settings');
  const [f, setF] = useState<any>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => setF(data), [data]);
  if (!f) return <Page title="Settings">Loading…</Page>;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  return (
    <Page title="Settings">
      <div className="card max-w-2xl space-y-4 p-6">
        <Toggle checked={f.block_role_addresses} onChange={(v) => set('block_role_addresses', v)} label="Never email role addresses" hint="info@, support@, sales@, admin@… These bounce and complain more." />
        <Toggle checked={f.require_dns} onChange={(v) => set('require_dns', v)} label="Pause mailboxes with broken SPF / DKIM / DMARC" hint="Strongly recommended" />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="label">Auto-pause above bounce rate (%)</span>
            <input type="number" step="0.5" min={1} max={10} className="input" value={f.bounce_pause_percent} onChange={(e) => set('bounce_pause_percent', Number(e.target.value))} />
          </div>
          <div>
            <span className="label">…after at least this many sends</span>
            <input type="number" min={10} className="input" value={f.bounce_min_sends} onChange={(e) => set('bounce_min_sends', Number(e.target.value))} />
          </div>
        </div>
        <p className="text-xs text-slate-500">Checked every 10 minutes over the last 7 days, per mailbox and per campaign.</p>
        <button className="btn-primary" onClick={async () => { setF(await api('/settings', { method: 'PUT', body: f })); setMsg('Saved.'); }}>Save</button>
        {msg && <Alert tone="ok">{msg}</Alert>}
      </div>
    </Page>
  );
}
