import { useState } from 'react';
import { useLoad, Page, Badge, Empty } from '../ui';
import { api, fmtDate } from '../api';
import { toast } from '../dialogs';

const INTEREST = [
  ['interested', 'Interested'],
  ['meeting_booked', 'Meeting booked'],
  ['not_interested', 'Not interested'],
] as const;

export function Inbox() {
  const [filter, setFilter] = useState('all');
  const { data: list, reload } = useLoad<any[]>(`/inbox?filter=${filter}`, []);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Page title="Unibox">
      <div className="mb-4 flex gap-1">
        {['all', 'unread', 'replies', 'interested'].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`rounded-lg px-3 py-1.5 text-sm capitalize ${filter === f ? 'bg-brand-dark text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}>{f}</button>
        ))}
      </div>
      {!list ? 'Loading…' : list.length === 0 ? <Empty>No replies yet. They'll show up here automatically.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
          <div className="card max-h-[75vh] divide-y divide-slate-100 overflow-y-auto">
            {list.map((m) => (
              <button key={m.cl_id} onClick={() => setOpen(m.cl_id)} className={`block w-full px-4 py-3 text-left hover:bg-slate-50 ${open === m.cl_id ? 'bg-sky-50' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-sm ${m.read ? '' : 'font-semibold'}`}>{[m.first_name, m.last_name].filter(Boolean).join(' ') || m.email}</span>
                  <span className="shrink-0 text-xs text-slate-400">{fmtDate(m.created_at)}</span>
                </div>
                <div className="truncate text-xs text-slate-500">{m.company} · {m.campaign}</div>
                <div className="mt-1 line-clamp-2 text-sm text-slate-600">{m.preview}</div>
                <div className="mt-1 flex gap-1">{m.kind === 'auto_reply' && <Badge value="auto reply" />}{m.interest && <Badge value={m.interest} />}</div>
              </button>
            ))}
          </div>
          {open ? <Thread clId={open} onChange={reload} /> : <div className="card flex items-center justify-center p-12 text-sm text-slate-500">Select a conversation</div>}
        </div>
      )}
    </Page>
  );
}

function Thread({ clId, onChange }: { clId: number; onChange: () => void }) {
  const { data, reload } = useLoad<any>(`/inbox/${clId}`, [clId]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="card p-6">Loading…</div>;
  const lead = data.lead;
  return (
    <div className="card flex max-h-[75vh] flex-col">
      <div className="border-b border-slate-200 px-5 py-3">
        <div className="font-semibold">{[lead.first_name, lead.last_name].filter(Boolean).join(' ')} <span className="font-normal text-slate-500">&lt;{lead.email}&gt;</span></div>
        <div className="text-xs text-slate-500">{lead.company} · {lead.campaign}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {INTEREST.map(([v, label]) => (
            <button key={v} className={`rounded-full px-2.5 py-1 text-xs ${lead.interest === v ? 'bg-brand text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              onClick={async () => { await api(`/leads/${lead.lead_id}`, { method: 'PATCH', body: { interest: lead.interest === v ? null : v } }); reload(); onChange(); }}>{label}</button>
          ))}
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`rounded-lg p-3 text-sm ${m.direction === 'out' ? 'ml-8 bg-slate-50' : 'mr-8 border border-slate-200'}`}>
            <div className="mb-1 flex justify-between text-xs text-slate-500">
              <span>{m.direction === 'out' ? `You (${m.from_email})` : m.from_email}{m.kind === 'bounce' ? ' · bounce' : m.kind === 'auto_reply' ? ' · auto-reply' : ''}</span>
              <span>{fmtDate(m.created_at)}</span>
            </div>
            <pre className="whitespace-pre-wrap font-sans">{m.fresh}</pre>
          </div>
        ))}
      </div>
      <div className="border-t border-slate-200 p-4">
        <textarea className="input min-h-24" placeholder="Write a reply… (sent from the same mailbox, in the same thread)" value={reply} onChange={(e) => setReply(e.target.value)} />
        <div className="mt-2 flex justify-end">
          <button className="btn-primary" disabled={!reply.trim() || busy} onClick={async () => {
            setBusy(true);
            try { await api(`/inbox/${clId}/reply`, { body: { body: reply } }); setReply(''); reload(); toast('Reply sent.'); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
          }}>{busy ? 'Sending…' : 'Send reply'}</button>
        </div>
      </div>
    </div>
  );
}
