import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function UserProfile() {
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    invoke<{content:string}>('workspace_request', {operation:'ai.profile.get', payload:{}})
      .then(value => { if (alive) { setContent(value.content); setLoaded(true); } })
      .catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, []);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      await invoke('workspace_request', {operation:'ai.profile.save', payload:{content}});
      setMessage('Saved. Grandpa will use this for subsequent tasks.');
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={e => { e.preventDefault(); void save(); }}>
    <label className="model-field" htmlFor="grandpa-user-profile">About you</label>
    <p>Add your name, projects, interests, and how you prefer Grandpa to help.</p>
    <textarea id="grandpa-user-profile" rows={8} maxLength={4000}
      style={{width:'100%', boxSizing:'border-box'}} value={content}
      disabled={!loaded || busy}
      onChange={e => { setContent(e.target.value); setMessage(''); }} />
    <p>{content.length}/4,000 characters</p>
    <button type="submit" disabled={!loaded || busy}>{busy ? 'Saving…' : 'Save profile'}</button>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
