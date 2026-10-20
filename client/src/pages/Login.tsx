import { useState } from 'react';
import { api } from '../api';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-dark px-4">
      <form
        className="card w-full max-w-sm p-8"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api('/login', { body: { password } });
            onDone();
          } catch (err: any) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1 className="mb-1 text-xl font-semibold">Conversion Labs Outreach</h1>
        <p className="mb-6 text-sm text-slate-500">Enter the dashboard password.</p>
        <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button className="btn-primary mt-4 w-full justify-center" disabled={busy || !password}>Log in</button>
      </form>
    </div>
  );
}
