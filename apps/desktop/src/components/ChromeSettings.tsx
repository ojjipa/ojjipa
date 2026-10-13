import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Status = {connected:boolean; title:string; url:string; error:string};
const request = <T,>(operation:string) => invoke<T>('workspace_request',{operation,payload:{}});
export default function ChromeSettings() {
  const [status,setStatus]=useState<Status|null>(null);
  const [code,setCode]=useState('');
  const [error,setError]=useState('');
  useEffect(()=>{
    let alive=true;
    const refresh=()=>request<Status>('browser.status').then(value=>{if(alive){setStatus(value);setError('');}}).catch(e=>{if(alive)setError(String(e));});
    void refresh();const timer=window.setInterval(()=>void refresh(),2000);
    return()=>{alive=false;window.clearInterval(timer);};
  },[]);
  async function pairing(){
    setError('');
    try{const result=await request<{code:string}>('browser.pair');setCode(result.code);}
    catch(e){setError(String(e));}
  }
  return <section className="content-panel model-settings-panel">
    <h2>Your Chrome tab</h2>
    <p>Let OJJIPA read and operate a tab you already have open. Connect the OJJIPA extension, then choose <strong>Use this tab</strong> in Chrome. Task workers can use that tab until you stop access.</p>
    <p role="status">{status?.connected?`Connected · ${status.title||status.url}`:'No Chrome tab connected.'}</p>
    <div className="model-settings-actions">
      <button className="text-link" onClick={()=>void invoke('open_chrome_extension_folder').catch(e=>setError(String(e)))}>Open extension folder</button>
      <button className="text-link" onClick={()=>void pairing()}>Show pairing code</button>
      {status?.connected&&<button className="text-link" onClick={()=>void request<Status>('browser.disconnect').then(setStatus).catch(e=>setError(String(e)))}>Stop tab access</button>}
    </div>
    {code&&<label className="model-field"><span>Copy this code into the extension · first connection only</span><input readOnly value={code} onFocus={e=>e.currentTarget.select()} /><button className="text-link" onClick={()=>setCode('')}>Hide code</button></label>}
    <p>Open <strong>chrome://extensions</strong>, enable Developer mode, choose <strong>Load unpacked</strong>, and select the extension folder. Chrome displays a debugger banner while tab access is active.</p>
    {(error||status?.error)&&<p role="alert" className="model-config-error">{error||status?.error}</p>}
  </section>;
}
