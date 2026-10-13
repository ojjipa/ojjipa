import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Settings = {
  model: string; base_url: string;
  timeout_seconds: number; has_api_key: boolean; has_tavily_key: boolean;
};

export default function ModelSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    invoke<Settings>('workspace_request', {operation:'ai.settings.get',payload:{}})
      .then(setSettings).catch(e => setError(String(e)));
  }, []);
  async function save(check = false) {
    if (!settings) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const saved = await invoke<Settings>('workspace_request', {operation:'ai.settings.save',payload:{
        model:settings.model, base_url:settings.base_url, timeout_seconds:settings.timeout_seconds,
        api_key:apiKey, tavily_key:tavilyKey,
      }});
      setSettings(saved); setApiKey(''); setTavilyKey('');
      setMessage(check ? 'Checking the real Hermes/model connection…' : 'Saved. Queued thoughts will be processed automatically.');
      if (check) {
        const result = await invoke<{message:string}>('workspace_request', {operation:'ai.check',payload:{}});
        setMessage('Hermes and your model are connected: ' + result.message);
      }
    } catch(e) { setMessage(''); setError(String(e)); }
    finally { setBusy(false); }
  }
  return <section className="content-panel model-settings-panel">
    <h2>Grandpa & Hermes</h2>
    <p>Grandpa judges your thoughts; temporary MiniPas use the real Hermes runtime. Your thought and relevant context are sent to the model provider you choose.</p>
    {settings && <>
      <label className="model-field"><span>Model name</span><input value={settings.model} onChange={e=>setSettings({...settings,model:e.target.value})} placeholder="Your provider’s exact model ID" /></label>
      <label className="model-field"><span>API base URL</span><input value={settings.base_url} onChange={e=>setSettings({...settings,base_url:e.target.value})} /></label>
      <div className="model-field-grid">
        <label className="model-field"><span>Model API key</span><input type="password" autoComplete="new-password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={settings.has_api_key?'Saved · leave blank to keep':'Enter locally'} /></label>
        <label className="model-field"><span>Tavily key for web research</span><input type="password" autoComplete="new-password" value={tavilyKey} onChange={e=>setTavilyKey(e.target.value)} placeholder={settings.has_tavily_key?'Saved · leave blank to keep':'Optional web search credential'} /></label>
      </div>
      <label className="model-field"><span>Task time budget (seconds)</span><input type="number" min={30} max={900} value={settings.timeout_seconds} onChange={e=>setSettings({...settings,timeout_seconds:Number(e.target.value)})} /></label>
      <p>Task workers have the full available Hermes toolset, including files, shell and browser. Pause stops execution; resume starts it again. Retire cancels it permanently. arXiv watchers run while OJJIPA is open.</p>
      <div className="model-settings-actions"><button className="primary-button" disabled={busy} onClick={()=>void save()}>{busy?'Working…':'Save settings'}</button><button className="text-link" disabled={busy} onClick={()=>void save(true)}>Save & check connection</button></div>
    </>}
    {message && <p className="model-config-feedback model-config-success" role="status">{message}</p>}
    {error && <p className="model-config-feedback model-config-error" role="alert">{error}</p>}
  </section>;
}
