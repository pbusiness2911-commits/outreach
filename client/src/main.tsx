import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import './index.css';
import { api } from './api';
import { DialogHost } from './dialogs';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Campaigns } from './pages/Campaigns';
import { CampaignDetail } from './pages/CampaignDetail';
import { Inbox } from './pages/Inbox';
import { Leads } from './pages/Leads';
import { Mailboxes } from './pages/Mailboxes';
import { Suppressions } from './pages/Suppressions';
import { Settings } from './pages/Settings';

const NAV = [
  ['/', 'Dashboard'],
  ['/campaigns', 'Campaigns'],
  ['/inbox', 'Unibox'],
  ['/leads', 'Leads'],
  ['/mailboxes', 'Mailboxes'],
  ['/do-not-contact', 'Do not contact'],
  ['/settings', 'Settings'],
] as const;

function App() {
  const [me, setMe] = useState<null | false | { dryRun: boolean; verifier: boolean }>(null);
  const check = () => api('/me').then(setMe).catch(() => setMe(false));
  useEffect(() => {
    check();
    const off = () => setMe(false);
    window.addEventListener('logged-out', off);
    return () => window.removeEventListener('logged-out', off);
  }, []);
  if (me === null) return null;
  if (me === false) return <Login onDone={check} />;
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col bg-brand-dark px-3 py-5 text-slate-300">
        <div className="mb-6 px-3 text-lg font-semibold text-white">
          Conversion <span className="text-ok">Labs</span>
          <div className="text-xs font-normal text-slate-400">Outreach</div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5 hover:text-white'}`}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-3">
          {me.dryRun && <div className="mb-3 rounded-md bg-amber-500/20 px-2 py-1.5 text-xs text-amber-200">Test mode: nothing is really sent</div>}
          <button className="text-xs text-slate-400 hover:text-white" onClick={() => api('/logout', { body: {} }).then(() => setMe(false))}>Log out</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/leads" element={<Leads verifier={me.verifier} />} />
          <Route path="/mailboxes" element={<Mailboxes />} />
          <Route path="/do-not-contact" element={<Suppressions />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <DialogHost />
    </BrowserRouter>
  </StrictMode>,
);
