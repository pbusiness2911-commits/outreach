import { useState } from 'react';
import { useLoad, Page, Badge, Alert } from '../ui';
import { api, fmtDate } from '../api';

export function Suppressions() {
  const [q, setQ] = useState('');
  const { data, reload } = useLoad<any[]>(`/suppressions${q ? `?q=${encodeURIComponent(q)}` : ''}`, []);
  const [values, setValues] = useState('');
  const [msg, setMsg] = useState<any>(null);
  return (
    <Page title="Do not contact">
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div>
          <input className="input mb-3 w-72" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="card overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50"><tr><th className="th">Email / domain</th><th className="th">Reason</th><th className="th">Added</th><th className="th"></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data?.map((s) => (
                  <tr key={s.id}>
                    <td className="td">{s.kind === 'domain' ? `@${s.value}` : s.value}</td>
                    <td className="td"><Badge value={s.reason} /></td>
                    <td className="td text-xs text-slate-500">{fmtDate(s.created_at)}</td>
                    <td className="td text-right">{s.reason !== 'unsubscribed' && <button className="text-xs text-slate-500 hover:text-red-600" onClick={async () => { if (!confirm(`Allow emailing ${s.value} again?`)) return; try { await api(`/suppressions/${s.id}`, { method: 'DELETE' }); reload(); } catch (e: any) { alert(e.message); } }}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data?.length === 0 && <div className="px-6 py-8 text-center text-sm text-slate-500">Empty. Unsubscribes and hard bounces are added automatically.</div>}
          </div>
        </div>
        <div className="card h-fit space-y-3 p-5">
          <h3 className="font-semibold">Add emails or domains</h3>
          <p className="text-xs text-slate-500">One per line. A domain (e.g. <code>competitor.com</code>) blocks everyone there. Current clients and competitors belong here.</p>
          <textarea className="input min-h-32" value={values} onChange={(e) => setValues(e.target.value)} placeholder={'someone@company.com\nclient-domain.com'} />
          <button className="btn-primary" disabled={!values.trim()} onClick={async () => { const r = await api('/suppressions', { body: { values } }); setMsg(`Added ${r.added}.`); setValues(''); reload(); }}>Add</button>
          {msg && <Alert tone="ok">{msg}</Alert>}
        </div>
      </div>
    </Page>
  );
}
