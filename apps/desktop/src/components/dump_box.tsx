import { useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

const DRAFT_KEY = 'ojjipa.dump.draft';
function readDraft() { try { return localStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; } }

export default function DumpBox({ popup = false, onSaved }: { popup?: boolean; onSaved?: () => void }) {
  const [text, setText] = useState(readDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);

  function change(value: string) {
    setText(value); setSaved(false);
    try { localStorage.setItem(DRAFT_KEY, value); } catch { /* Input stays usable if storage is unavailable. */ }
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === DRAFT_KEY) { setText(event.newValue || ''); setSaved(false); } };
    window.addEventListener('storage', sync);
    if (popup) editor.current?.focus();
    const unlisten = isTauri() ? listen('dump-focus', () => { setError(''); editor.current?.focus(); }) : null;
    return () => { window.removeEventListener('storage', sync); if (unlisten) void unlisten.then(stop => stop()); };
  }, [popup]);

  async function close() {
    try { if (isTauri()) await invoke('close_dump'); }
    catch (e) { setError(String(e)); }
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (submitting.current || !text.trim()) return;
    const submitted = text;
    submitting.current = true;
    setBusy(true); setError('');
    try {
      if (!isTauri()) throw new Error('Open the desktop app to save your thought.');
      await invoke('submit_dump', { content: submitted.trim() });
      // Another window may have edited the shared draft while this save was pending.
      if (readDraft() === submitted) change('');
      else setText(readDraft());
      setSaved(true); onSaved?.();
      // Saving succeeded even if another window has already closed.
      void emit('dump-saved').catch(() => {});
      if (popup) await close();
    } catch (e) { setError(String(e)); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <form className={`dump-box ${popup ? 'dump-box-popup' : ''}`} onSubmit={submit}>
    <div className="dump-input-row"><span className="dump-plus" aria-hidden="true">＋</span>
      <label className="sr-only" htmlFor={popup ? 'popup-dump' : 'home-dump'}>Leave a thought for Grandpa</label>
      <textarea ref={editor} id={popup ? 'popup-dump' : 'home-dump'} placeholder="Throw something at me…" value={text} maxLength={8000} disabled={busy} rows={popup ? 3 : 2}
        onChange={e => change(e.target.value)} onKeyDown={e => {
          if (e.key === 'Escape' && popup) { e.preventDefault(); void close(); }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
        }}/>
      <button type="submit" className="dump-send" aria-label="Save dump" title="Save · Ctrl/⌘ Enter" disabled={busy || !text.trim()}>{busy ? '…' : '↗'}</button>
    </div>
    <div className="dump-meta"><span>{busy ? 'Saving…' : saved ? 'Saved. You can get back to it.' : ''}</span><span>{popup ? 'ESC TO CLOSE' : 'CTRL / ⌘ ENTER'}</span></div>
    {error && <p className="dump-error" role="alert">{error}</p>}
    {saved && !popup && <span className="sr-only" role="status">Dump saved</span>}
  </form>;
}
