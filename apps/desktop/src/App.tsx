import { useCallback, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import DumpBox from './components/dump_box';
import Grandpa from './components/Grandpa';
import './App.css';

type Minipa = { id: number; purpose: string; kind: string; status: string; source: string | null; termination_condition: string | null };
type Report = { hold_id: number; report_id: number; content: string; surfaced_at: string; minipa_id: number };
type Workspace = { preferences: { focus_enabled: boolean; auto_surface_enabled: boolean }; held_count: number; surfaced_reports: Report[]; minipas: Minipa[]; dumps: { id: number; content: string; created_at: string }[] };
const popup = new URLSearchParams(window.location.search).get('view') === 'dump';
if (popup) document.documentElement.classList.add('capture-document');
async function api<T>(operation: string, payload: object = {}) { return invoke<T>('hold_queue_request', { operation, payload }); }
function timestamp(value: string) { return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

function Popup() {
  return <div className="capture-window"><DumpBox popup /></div>;
}

function WorkspaceApp() {
  const [page, setPage] = useState<'home' | 'notifications' | 'minipas'>('home');
  const [state, setState] = useState<Workspace | null>(null);
  const [connection, setConnection] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!isTauri()) { setConnection('Open the desktop app to connect to your local engine.'); return; }
    try { setState(await api<Workspace>('workspace.get')); setConnection(''); }
    catch (e) { setConnection(String(e)); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 4000);
    const unlisten = isTauri() ? listen('dump-saved', () => { void refresh(); }) : null;
    if (isTauri()) void invoke<string | null>('shortcut_status').then(setShortcutError).catch(() => {});
    return () => { window.clearInterval(timer); if (unlisten) void unlisten.then(stop => stop()); };
  }, [refresh]);
  async function action(operation: string, payload: object = {}) {
    setBusy(true); setError('');
    try { await api(operation, payload); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function openCapture() { try { await invoke('open_dump'); } catch (e) { setError(String(e)); } }
  const active = state?.minipas.filter(agent => agent.status !== 'retired').length || 0;

  return <div className="workroom">
    <aside className="sidebar"><button className="boxed-brand" onClick={() => setPage('home')}>OJJIPA</button><p className="sidebar-label">YOUR WORKROOM</p>
      <nav aria-label="Main navigation">
        <button className={page === 'home' ? 'active' : ''} onClick={() => setPage('home')}><span className="nav-icon">⌂</span>Home</button>
        <button className={page === 'notifications' ? 'active' : ''} onClick={() => setPage('notifications')}><span className="nav-icon">◷</span>Notifications{Boolean(state?.surfaced_reports.length) && <span className="nav-count">{state?.surfaced_reports.length}</span>}</button>
        <button className={page === 'minipas' ? 'active' : ''} onClick={() => setPage('minipas')}><span className="nav-icon">♧</span>MiniPas{active > 0 && <span className="nav-count">{active}</span>}</button>
      </nav>
    </aside>
    <div className="workspace"><header className="topbar"><div><span className="privacy-label"></span></div></header>
      {connection && <p className="connection-note" role="status">{connection}</p>}
      {error && <div className="app-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
      {shortcutError && <p className="connection-note">The keyboard shortcut is unavailable. Use the capture button or tray menu.</p>}
      {page === 'home' && <main className="home-page"><div className="home-center"><Grandpa/><p className="home-caption"></p><DumpBox onSaved={() => void refresh()}/><p className="capture-hint">Shortcuts: <kbd>Ctrl / ⌘</kbd><kbd>Shift</kbd><kbd>Space</kbd></p></div>
        {Boolean(state?.dumps.length) && <details className="recent-dumps"><summary>Your Dumps <span>{state?.dumps.length}</span></summary>{state?.dumps.map(dump => <div className="recent-row" key={dump.id}><p>{dump.content}</p><time>{timestamp(dump.created_at)}</time></div>)}</details>}
      </main>}
      {page === 'notifications' && <main className="content-page"><h1>Notifcations</h1><p className="page-caption">Updates and reports inbox.</p>
        <div className="held-strip"><div><strong>{state?.held_count || 0}</strong><span> held for you</span></div><button disabled={!state?.held_count || busy} onClick={() => void action('attention.surface')}>Show the next one <span>→</span></button></div>
        {!state?.surfaced_reports.length && <div className="empty-state"><Grandpa small/><h2>Nothing is here.</h2></div>}
        <div className="report-list">{state?.surfaced_reports.map(report => <article className="report-card" key={report.hold_id}><div className="eyebrow">MINIPA #{report.minipa_id}<time>{timestamp(report.surfaced_at)}</time></div><h2>Finished work.</h2><p className="report-content">{report.content}</p><small>REPORT #{report.report_id}</small></article>)}</div>
      </main>}
      {page === 'minipas' && <main className="content-page"><h1>MiniPas</h1><p className="page-caption">Your beloved agents.</p>
        {!state?.minipas.length && <div className="empty-state"><Grandpa small/><h2>No MiniPas yet.</h2></div>}
        {state?.minipas.map(agent => <article className="minipa-row" key={agent.id}><div className="minipa-avatar" aria-hidden="true">••</div><div className="minipa-info"><div className="eyebrow">{agent.kind} / #{agent.id}</div><h2>{agent.purpose}</h2>{agent.source && <p>{agent.source}</p>}{agent.termination_condition && <small>{agent.termination_condition}</small>}</div><div className="minipa-controls"><span className={`agent-status ${agent.status}`}>{agent.status}</span>{agent.status !== 'retired' && <div><button disabled={busy} onClick={() => void action('minipa.update', { id: agent.id, status: agent.status === 'paused' ? 'active' : 'paused' })}>{agent.status === 'paused' ? 'Resume' : 'Pause'}</button><button disabled={busy} onClick={() => void action('minipa.update', { id: agent.id, status: 'retired' })}>Retire</button></div>}</div></article>)}
      </main>}
     
    </div>
  </div>;
}

export default function App() { return popup ? <Popup/> : <WorkspaceApp/>; }
