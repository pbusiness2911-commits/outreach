import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { api } from './api';

export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

const STATUS_STYLES: Record<string, string> = {
  running: 'bg-green-100 text-green-800', active: 'bg-green-100 text-green-800', valid: 'bg-green-100 text-green-800', replied: 'bg-blue-100 text-blue-800',
  interested: 'bg-blue-100 text-blue-800', meeting_booked: 'bg-indigo-100 text-indigo-800',
  paused: 'bg-amber-100 text-amber-800', queued: 'bg-slate-100 text-slate-700', draft: 'bg-slate-100 text-slate-700', unverified: 'bg-slate-100 text-slate-700',
  completed: 'bg-slate-200 text-slate-700', sending: 'bg-sky-100 text-sky-800', catch_all: 'bg-amber-100 text-amber-800', risky: 'bg-amber-100 text-amber-800',
  error: 'bg-red-100 text-red-800', bounced: 'bg-red-100 text-red-800', invalid: 'bg-red-100 text-red-800', unsubscribed: 'bg-red-50 text-red-700',
  skipped: 'bg-slate-100 text-slate-500', stopped: 'bg-slate-100 text-slate-500', not_interested: 'bg-slate-100 text-slate-500',
};

export function Badge({ value }: { value?: string | null }) {
  if (!value) return null;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[value] || 'bg-slate-100 text-slate-700'}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-brand-dark">{title}</h1>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : tone === 'ok' ? 'text-green-700' : 'text-brand-dark';
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const s = { info: 'border-sky-200 bg-sky-50 text-sky-900', warn: 'border-amber-200 bg-amber-50 text-amber-900', error: 'border-red-200 bg-red-50 text-red-900', ok: 'border-green-200 bg-green-50 text-green-900' }[tone];
  return <div className={`rounded-lg border px-4 py-3 text-sm ${s}`}>{children}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16" onMouseDown={onClose}>
      <div className={`card w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} p-6 shadow-xl`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1.5">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card px-6 py-12 text-center text-sm text-slate-500">{children}</div>;
}
