import { invoke, isTauri } from '@tauri-apps/api/core';
import { useState } from 'react';

export default function ReportContent({content}: {content:string}) {
  const [error,setError] = useState('');
  let summary = content;
  try { const report = JSON.parse(content); if (typeof report.summary === 'string') summary = report.summary; } catch { /* Legacy reports are plain text. */ }
  return <><p style={{whiteSpace:'pre-wrap'}}>{summary.split(/(https?:\/\/[^\s<>]+)/g).map((part,index)=>
    /^https?:\/\//.test(part) ? <a key={index} href={part.replace(/[),.]+$/,'')} target="_blank" rel="noreferrer" onClick={event=>{if(isTauri()){event.preventDefault();setError('');void invoke('reader_open',{url:part.replace(/[),.]+$/,'')}).catch(e=>setError(String(e)));}}}>{part}</a> : part
  )}</p>{error&&<p role="alert" className="captured-error">{error}</p>}</>;
}
