// In-app replacements for the browser's prompt(), confirm() and alert().
// Call askText / askConfirm / toast from anywhere; <DialogHost /> (mounted once in main.tsx) renders them.
import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from './ui';

type TextReq = { kind: 'text'; title: string; label?: string; initial?: string; placeholder?: string; confirmLabel?: string; resolve: (v: string | null) => void };
type ConfirmReq = { kind: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void };
type Req = TextReq | ConfirmReq;
type Toast = { id: number; text: string; tone: 'ok' | 'error' | 'info' };

let pushReq: ((r: Req) => void) | null = null;
let pushToast: ((t: Toast) => void) | null = null;
let toastId = 0;

export function askText(opts: Omit<TextReq, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => pushReq?.({ kind: 'text', ...opts, resolve }));
}

export function askConfirm(opts: Omit<ConfirmReq, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => pushReq?.({ kind: 'confirm', ...opts, resolve }));
}

export function toast(text: string, tone: Toast['tone'] = 'ok') {
  pushToast?.({ id: ++toastId, text, tone });
}

export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [value, setValue] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    pushReq = (r) => {
      setValue(r.kind === 'text' ? r.initial ?? '' : '');
      setReq(r);
    };
    pushToast = (t) => {
      setToasts((ts) => [...ts, t]);
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), t.tone === 'error' ? 7000 : 3500);
    };
    return () => {
      pushReq = null;
      pushToast = null;
    };
  }, []);

  const close = (result: string | boolean | null) => {
    if (!req) return;
    if (req.kind === 'text') req.resolve(typeof result === 'string' ? result : null);
    else req.resolve(result === true);
    setReq(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (req?.kind === 'text') {
      if (value.trim()) close(value.trim());
    } else close(true);
  };

  return (
    <>
      {req && (
        <Modal title={req.title} onClose={() => close(null)}>
          <form onSubmit={submit} className="space-y-4">
            {req.kind === 'text' ? (
              <div>
                {req.label && <span className="label">{req.label}</span>}
                <input autoFocus className="input" value={value} placeholder={req.placeholder} onChange={(e) => setValue(e.target.value)} />
              </div>
            ) : (
              <p className="text-sm text-slate-600">{req.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => close(null)}>Cancel</button>
              <button
                type="submit"
                autoFocus={req.kind === 'confirm'}
                className={req.kind === 'confirm' && req.danger ? 'btn bg-red-600 text-white hover:bg-red-700' : 'btn-primary'}
                disabled={req.kind === 'text' && !value.trim()}
              >
                {req.confirmLabel || (req.kind === 'text' ? 'Save' : 'Confirm')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg ${
              t.tone === 'error' ? 'border-red-200 bg-red-50 text-red-900' : t.tone === 'info' ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-green-200 bg-green-50 text-green-900'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
