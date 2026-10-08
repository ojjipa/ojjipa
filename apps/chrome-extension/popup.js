const status=document.querySelector('#status'),error=document.querySelector('#error');
async function refresh(){const value=await chrome.runtime.sendMessage({type:'status'});status.textContent=value.connected?`Connected: ${value.tab?.title||'Your tab'}`:'Open a page and choose Use this tab.';error.textContent=value.error||'';}
document.querySelector('#connect').onclick=async()=>{
  error.textContent='';
  try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});const result=await chrome.runtime.sendMessage({type:'connect',tabId:tab.id,code:document.querySelector('#code').value.trim()});if(result.error)throw new Error(result.error);document.querySelector('#code').value='';await refresh();}catch(e){error.textContent=e.message;}
};
document.querySelector('#stop').onclick=async()=>{await chrome.runtime.sendMessage({type:'stop'});await refresh();};
void refresh();
