import { useState } from 'react';
import { useLoad, Page, Badge, Alert } from '../ui';
import { api } from '../api';

export function Leads({ verifier }: { verifier: boolean }) {
  const [q, setQ] = useState('');
  const [v, setV] = useState('');
  const [page, setPage] = useState(0);
  const { data, reload } = useLoad<any>(`/leads?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}${v ? `&verification=${v}` : ''}`, []);
  const stat = (k: string) => data?.stats.find((s: any) => s.verification_status === k)?.n ?? 0;
  return (
    <Page title="Leads">
      {!verifier && (
        <div className="mb-4">
          <Alert tone="warn">No email verification service connected. Leads only get a basic check (format, domain, disposable). Add a MillionVerifier API key to fully verify every address and keep bounces under 2%.</Alert>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {['valid', 'catch_all', 'risky', 'invalid', 'unverified'].map((k) => (
          <button key={k} onClick={() => { setV(v === k ? '' : k); setPage(0); }} className={`rounded-lg border px-3 py-1.5 ${v === k ? 'border-brand bg-sky-50' : 'border-slate-200 bg-white'}`}>
            <Badge value={k} /> <span className="ml-1 font-medium">{stat(k)}</span>
          </button>
        ))}
        <input className="input ml-auto w-64" placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50"><tr><th className="th">Email</th><th className="th">Name</th><th className="th">Company</th><th className="th">Verification</th><th className="th">Interest</th><th className="th">Campaigns</th><th className="th"></th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data?.rows.map((l: any) => (
              <tr key={l.id}>
                <td className="td">{l.email}</td>
                <td className="td">{[l.first_name, l.last_name].filter(Boolean).join(' ')}</td>
                <td className="td">{l.company}</td>
                <td className="td"><Badge value={l.verification_status} />{l.verification_detail && <div className="text-xs text-slate-500">{l.verification_detail}</div>}</td>
                <td className="td"><Badge value={l.interest} /></td>
                <td className="td max-w-64 truncate text-xs text-slate-500" title={l.campaigns}>{l.campaigns}</td>
                <td className="td text-right"><button className="text-xs text-slate-500 hover:text-brand" onClick={async () => { await api('/leads/reverify', { body: { ids: [l.id] } }); reload(); }}>Re-verify</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > 100 && (
        <div className="mt-4 flex items-center gap-2">
          <button className="btn-ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <button className="btn-ghost" disabled={(page + 1) * 100 >= data.total} onClick={() => setPage(page + 1)}>Next</button>
          <span className="text-sm text-slate-500">{data.total} leads</span>
        </div>
      )}
    </Page>
  );
}
