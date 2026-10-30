import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Status = {connected:boolean; title:string; url:string; error:string};
const request = <T,>(operation:string) => invoke<T>('workspace_request',{operation,payload:{}});
export default function ChromeSettings() {
  const [status,setStatus]=useState<Status|null>(null);
  const [code,setCode]=useState('');
  const [error,setError]=useState('');
  const [isOpeningSetup,setIsOpeningSetup]=useState(false);
  const [setupStarted,setSetupStarted]=useState(false);
  const [pairingCodeCopied,setPairingCodeCopied]=useState(false);
  const [extensionFolder,setExtensionFolder]=useState('');
  const [extensionPathCopied,setExtensionPathCopied]=useState(false);
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
  async function openSetup(){
    setError('');
    setIsOpeningSetup(true);
    try{
      const result=await request<{code:string}>('browser.pair');
      setCode(result.code);
      try{await navigator.clipboard.writeText(result.code);setPairingCodeCopied(true);}catch{setPairingCodeCopied(false);}
      const folder=await invoke<string>('set_up_chrome_extension');
      setExtensionFolder(folder);
      setSetupStarted(true);
    }
    catch(e){setError(String(e));}
    finally{setIsOpeningSetup(false);}
  }
  return <section className="content-panel model-settings-panel chrome-settings-panel">
    <div className="settings-section-heading">
      <p className="workroom-overline">CHROME ACCESS</p>
      <h2>Your Chrome tab</h2>
      <p>Let OJJIPA read and operate a tab you already have open. Connect the OJJIPA extension, then choose <strong>Use this tab</strong> in Chrome. Task workers can use that tab until you stop access.</p>
    </div>
    <p role="status">{status?.connected?`Connected · ${status.title||status.url}`:'No Chrome tab connected.'}</p>
    <div className="model-settings-actions chrome-setup-actions">
      <button className="primary-button" type="button" disabled={!status || isOpeningSetup} onClick={()=>void openSetup()}>{isOpeningSetup?'Preparing Chrome…':'Start Chrome setup'}</button>
      <button className="text-link" type="button" onClick={()=>void pairing()}>Show pairing code</button>
      {status?.connected&&<button className="text-link" onClick={()=>void request<Status>('browser.disconnect').then(setStatus).catch(e=>setError(String(e)))}>Stop tab access</button>}
    </div>
    {code&&<label className="model-field"><span>{setupStarted&&pairingCodeCopied?'Pairing code copied · paste it into the OJJIPA extension':'Pairing code · first connection only'}</span><input readOnly value={code} onFocus={e=>e.currentTarget.select()} /><button className="text-link" type="button" onClick={()=>void navigator.clipboard.writeText(code).then(()=>setPairingCodeCopied(true)).catch(()=>{setPairingCodeCopied(false);setError('Select and copy the pairing code above.');})}>{pairingCodeCopied?'Copied':'Copy code'}</button><button className="text-link" type="button" onClick={()=>setCode('')}>Hide code</button></label>}
    <div className="chrome-install-guide"><p className="workroom-overline">QUICK LOCAL INSTALL</p><ol><li><span>01</span><p>Turn on <strong>Developer mode</strong> in the Chrome page that opened.</p></li><li><span>02</span><p>Choose <strong>Load unpacked</strong>. In Chrome’s folder picker, press <kbd>⌘⇧G</kbd>, paste the OJJIPA folder path below, and choose <strong>Open</strong>.</p></li><li><span>03</span><p>Open the OJJIPA extension, paste the copied pairing code, then choose <strong>Use this tab</strong>.</p></li></ol>
      {extensionFolder&&<div className="chrome-extension-path"><code title={extensionFolder}>{extensionFolder}</code><button className="text-link" type="button" onClick={()=>void navigator.clipboard.writeText(extensionFolder).then(()=>setExtensionPathCopied(true)).catch(()=>setError('Select and copy the extension folder path above.'))}>{extensionPathCopied?'Folder path copied':'Copy folder path'}</button></div>}
      <small>The extension is copied to OJJIPA’s accessible application support folder, so Chrome’s folder picker can open it. Chrome requires you to confirm loading an unpacked extension.</small></div>
    {(error||status?.error)&&<p role="alert" className="model-config-error">{error||status?.error}</p>}
  </section>;
}
