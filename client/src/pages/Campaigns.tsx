import { Link, useNavigate } from 'react-router-dom';
import { useLoad, Page, Badge, Empty } from '../ui';
import { api, pct } from '../api';

export function Campaigns() {
  const { data, reload } = useLoad<any[]>('/campaigns');
  const nav = useNavigate();
  const create = async () => {
    const name = prompt('Campaign name');
    if (!name) return;
    const c = await api('/campaigns', { body: { name } });
    nav(`/campaigns/${c.id}`);
  };
  return (
    <Page title="Campaigns" actions={<button className="btn-primary" onClick={create}>+ New campaign</button>}>
      {!data ? 'Loading…' : data.length === 0 ? (
        <Empty>No campaigns yet. Create one to get started.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr><th className="th">Name</th><th className="th">Status</th><th className="th">Leads</th><th className="th">Contacted</th><th className="th">Replied</th><th className="th">Bounced</th><th className="th">Interested</th><th className="th"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="td font-medium"><Link to={`/campaigns/${c.id}`} className="hover:text-brand">{c.name}</Link>{c.paused_reason && c.status === 'paused' && <div className="text-xs text-amber-700">{c.paused_reason}</div>}</td>
                  <td className="td"><Badge value={c.status} /></td>
                  <td className="td">{c.stats.leads}</td>
                  <td className="td">{c.stats.contacted}</td>
                  <td className="td">{c.stats.replied} <span className="text-xs text-slate-500">({pct(c.stats.replied, c.stats.contacted)})</span></td>
                  <td className="td">{c.stats.bounced} <span className="text-xs text-slate-500">({pct(c.stats.bounced, c.stats.contacted)})</span></td>
                  <td className="td">{c.stats.interested}</td>
                  <td className="td text-right">
                    <button className="text-xs text-slate-500 hover:text-brand" onClick={async () => { await api(`/campaigns/${c.id}/duplicate`, { body: {} }); reload(); }}>Duplicate</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
