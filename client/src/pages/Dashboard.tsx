import { Link } from 'react-router-dom';
import { useLoad, Page, Stat, Badge, Alert } from '../ui';
import { fmtDate, pct } from '../api';

export function Dashboard() {
  const { data } = useLoad<any>('/dashboard');
  const { data: mbs } = useLoad<any[]>('/mailboxes');
  if (!data) return <Page title="Dashboard">Loading…</Page>;
  const t = data.totals;
  const bounceRate = t.sent_7d ? t.bounces_7d / t.sent_7d : 0;
  const max = Math.max(1, ...data.daily.map((d: any) => d.sent));
  const problems = (mbs || []).filter((m) => m.status !== 'active');
  return (
    <Page title="Dashboard">
      {problems.length > 0 && (
        <div className="mb-6">
          <Alert tone="warn">
            {problems.length} mailbox{problems.length > 1 ? 'es are' : ' is'} not sending: {problems.map((m) => `${m.email} (${m.paused_reason || m.status})`).join('; ')}.{' '}
            <Link to="/mailboxes" className="underline">Review mailboxes</Link>
          </Alert>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Sent today" value={t.sent_today} />
        <Stat label="Sent (7 days)" value={t.sent_7d} />
        <Stat label="Replies (7 days)" value={t.replies_7d} hint={`${pct(t.replies_7d, t.sent_7d)} reply rate`} tone="ok" />
        <Stat label="Bounces (7 days)" value={t.bounces_7d} hint={`${pct(t.bounces_7d, t.sent_7d)} — keep under 2%`} tone={bounceRate > 0.03 ? 'bad' : bounceRate > 0.02 ? 'warn' : undefined} />
        <Stat label="Unread replies" value={<Link to="/inbox" className="hover:underline">{t.unread}</Link>} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold">Last 14 days</h2>
          {data.daily.length === 0 ? (
            <p className="text-sm text-slate-500">No sends yet.</p>
          ) : (
            <div className="flex h-44 items-end gap-1.5">
              {data.daily.map((d: any) => (
                <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${d.sent} sent, ${d.replies} replies, ${d.bounces} bounces`}>
                  <div className="flex w-full flex-col justify-end" style={{ height: 150 }}>
                    <div className="w-full rounded-t bg-brand" style={{ height: `${(d.sent / max) * 100}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-500">{d.day.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card p-5">
          <h2 className="mb-3 text-sm font-semibold">Mailbox health</h2>
          <div className="space-y-2">
            {(mbs || []).map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{m.email}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                  {m.sent_24h}/{m.cap_today} <Badge value={m.status} />
                </span>
              </div>
            ))}
            {mbs?.length === 0 && <p className="text-sm text-slate-500"><Link className="underline" to="/mailboxes">Add your first mailbox</Link></p>}
          </div>
        </div>
      </div>

      <div className="card mt-6">
        <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold">Activity</h2>
        <ul className="divide-y divide-slate-100">
          {data.events.map((e: any) => (
            <li key={e.id} className="flex gap-3 px-5 py-2.5 text-sm">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${e.level === 'error' ? 'bg-red-500' : e.level === 'warn' ? 'bg-amber-500' : 'bg-slate-300'}`} />
              <span className="flex-1">{e.message}</span>
              <span className="shrink-0 text-xs text-slate-400">{fmtDate(e.created_at)}</span>
            </li>
          ))}
          {data.events.length === 0 && <li className="px-5 py-6 text-sm text-slate-500">Nothing yet.</li>}
        </ul>
      </div>
    </Page>
  );
}
