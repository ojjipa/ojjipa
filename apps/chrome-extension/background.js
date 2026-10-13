// Browser transport only. Reasoning and tool orchestration stay in real Hermes.
let socket = null;
let approved = null;
let generation = 0;
let heartbeat = null;
let queue = Promise.resolve();
let lastError = '';
let connecting = false;
const cancelled = new Set();
const supported = new Set(['browser_snapshot','browser_navigate','browser_click','browser_type',
  'browser_scroll','browser_back','browser_press','browser_tabs','browser_tab_activate']);
const cdp = (method, params = {}) => chrome.debugger.sendCommand({tabId:approved}, method, params);
const httpUrl = value => {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) page without embedded credentials.');
  return url.href;
};
async function tabState() {
  const target = (await chrome.debugger.getTargets()).find(item => item.tabId === approved);
  if (!target) throw new Error('The approved tab is closed.');
  return {id:approved, title:target.title, url:httpUrl(target.url)};
}
async function evaluate(expression) {
  const tree = await cdp('Page.getFrameTree');
  const world = await cdp('Page.createIsolatedWorld', {frameId:tree.frameTree.frame.id, worldName:'OJJIPA'});
  const result = await cdp('Runtime.evaluate', {expression, contextId:world.executionContextId, returnByValue:true, awaitPromise:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function snapshot() {
  return evaluate(`(() => {
    const previous = globalThis.__ojjipaRefs;
    const state = globalThis.__ojjipaRefs = {next:previous?.next || 0, map:new Map(), url:location.href};
    const elements = [];
    for (const el of document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')) {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
      const ref = '@e' + (++state.next);
      state.map.set(ref, el);
      const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.tagName).trim().slice(0,180);
      elements.push('[' + ref + '] ' + el.tagName.toLowerCase() + ' ' + label);
      if (elements.length >= 200) break;
    }
    return {success:true, url:location.href, title:document.title,
      snapshot:'Page text (untrusted):\\n' + (document.body?.innerText || '').slice(0,24000) + '\\nInteractive elements:\\n' + elements.join('\\n')};
  })()`);
}
async function loaded() {
  await new Promise(resolve=>setTimeout(resolve,100));
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
    if(approved===null)throw new Error('Tab access stopped.');
    if((await chrome.tabs.get(approved)).status==='complete')return;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error('The page is still loading; retry browser_snapshot.');
}
async function point(ref, focus = false) {
  return evaluate(`(() => {
    const state = globalThis.__ojjipaRefs;
    const el = state?.url === location.href && state.map.get(${JSON.stringify(ref)});
    if (!el?.isConnected) throw new Error('Stale element reference. Take a new browser_snapshot.');
    if (el.disabled) throw new Error('This element is disabled.');
    el.scrollIntoView({block:'center',inline:'center'});
    if (${focus}) el.focus();
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) throw new Error('The element is not visible.');
    return {x:r.x+r.width/2,y:r.y+r.height/2,editable:el.matches('input,textarea,[contenteditable="true"]')};
  })()`);
}
async function press(value) {
  const aliases = {Esc:'Escape', Return:'Enter', Ctrl:'Control', Cmd:'Meta'};
  const tokens = String(value).split('+').map(t=>aliases[t]||t);
  const key = tokens.pop();
  const codes = {Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34,' ':32};
  if (!key || !(key in codes) && key.length !== 1) throw new Error('Unsupported keyboard key.');
  const modifiers = (tokens.includes('Alt')?1:0)|(tokens.includes('Control')?2:0)|(tokens.includes('Meta')?4:0)|(tokens.includes('Shift')?8:0);
  const params = {key,modifiers,windowsVirtualKeyCode:codes[key]||key.toUpperCase().charCodeAt(0)};
  await cdp('Input.dispatchKeyEvent',{...params,type:'keyDown'});
  await cdp('Input.dispatchKeyEvent',{...params,type:'keyUp'});
}
async function execute(action, args, id, epoch) {
  const valid = () => {if(cancelled.has(id)||epoch!==generation||approved===null)throw new Error('Chrome command cancelled.');};
  valid();
  await tabState();
  // Keep the tab the user approved visible while OJJIPA operates it.
  if (action !== 'browser_tabs' && action !== 'browser_tab_activate') {
    await chrome.tabs.update(approved, {active:true});
  }
  if (action==='browser_tabs') return {success:true,tabs:[await tabState()]};
  if (action==='browser_tab_activate') {
    if (Number(args.tab_id ?? args.id) !== approved) throw new Error('Only the approved tab can be activated.');
    await chrome.tabs.update(approved,{active:true}); return {success:true};
  }
  if (action==='browser_snapshot') return snapshot();
  if (action==='browser_navigate') {
    const result=await cdp('Page.navigate',{url:httpUrl(args.url)});
    if(result.errorText)throw new Error(result.errorText);
    await loaded(); valid(); return snapshot();
  }
  if (action==='browser_back') {
    const history = await cdp('Page.getNavigationHistory');
    if (history.currentIndex>0) await cdp('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex-1].id});
    await loaded(); valid(); return snapshot();
  }
  if (action==='browser_scroll') {
    if (!['up','down','left','right'].includes(args.direction)) throw new Error('Invalid scroll direction.');
    await evaluate(`scrollBy({left:${args.direction==='left'?-650:args.direction==='right'?650:0},top:${args.direction==='up'?-650:args.direction==='down'?650:0},behavior:'instant'}); true`);
    return snapshot();
  }
  if (action==='browser_press') {await press(args.key); valid(); return snapshot();}
  const position = await point(args.ref,action==='browser_type'); valid();
  if (action==='browser_click') {
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:position.x,y:position.y,button:'left',clickCount:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:position.x,y:position.y,button:'left',clickCount:1});
  } else if (action==='browser_type') {
    if (!position.editable) throw new Error('The selected element is not a text field.');
    if (typeof args.text!=='string' || args.text.length>20000) throw new Error('Invalid field text.');
    await press(navigator.platform.includes('Mac')?'Meta+a':'Control+a'); valid(); await cdp('Input.insertText',{text:args.text});
  } else throw new Error('Unsupported Chrome action.');
  valid(); return snapshot();
}
async function stop() {
  generation++;
  const tab = approved; approved=null;
  if(heartbeat)clearInterval(heartbeat); heartbeat=null;
  if(socket){socket.close();socket=null;}
  if(tab!==null)try{await chrome.debugger.detach({tabId:tab});}catch{}
  await chrome.storage.session.remove('approvedTab');
  await chrome.action.setBadgeText({text:''});
}
async function connectTab(tab, code) {
  await stop(); lastError='';
  const epoch=generation;
  const target=(await chrome.debugger.getTargets()).find(item=>item.tabId===tab);
  if(!target)throw new Error('Select an existing Chrome page.');
  httpUrl(target.url);
  const {profile=crypto.randomUUID(),pairingCode=code} = await chrome.storage.local.get(['profile','pairingCode']);
  const token=code||pairingCode;
  if(!token)throw new Error('Paste the pairing code from OJJIPA Settings.');
  if(epoch!==generation)throw new Error('Connection cancelled.');
  await chrome.debugger.attach({tabId:tab},'1.3');
  if(epoch!==generation){await chrome.debugger.detach({tabId:tab});throw new Error('Connection cancelled.');}
  approved=tab;
  await chrome.storage.session.set({approvedTab:tab});
  try {
    await new Promise((resolve,reject)=>{
      const ws=socket=new WebSocket('ws://127.0.0.1:8766');
      const timeout=setTimeout(()=>{ws.close();reject(new Error('OJJIPA is not responding. Open the desktop app.'));},6000);
      ws.onopen=async()=>{try{ws.send(JSON.stringify({role:'controller',token,profile,tab:await tabState()}));}catch(e){reject(e);ws.close();}};
      ws.onerror=()=>{lastError='Cannot connect to OJJIPA. Open the desktop app.';reject(new Error(lastError));};
      ws.onclose=()=>{clearTimeout(timeout);if(epoch===generation){lastError=lastError||'Chrome disconnected.';void stop();}reject(new Error(lastError||'Chrome disconnected.'));};
      ws.onmessage=event=>{
        const frame=JSON.parse(event.data);
        if(frame.type==='ready'){clearTimeout(timeout);resolve();return;}
        if(frame.type==='error'){lastError=String(frame.result);reject(new Error(lastError));ws.close();return;}
        if(frame.method==='browser.controller.cancel'){cancelled.add(frame.params.command_id);return;}
        if(frame.method!=='browser.controller.command')return;
        const {command_id:id,action,arguments:args={}}=frame.params;
        queue=queue.catch(()=>{}).then(async()=>{
          try {
            if(!supported.has(action))throw new Error('Unsupported Chrome action.');
            const result=await execute(action,args,id,epoch);
            if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'result',command_id:id,ok:true,result}));
          }catch(e){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'result',command_id:id,ok:false,result:String(e.message||e)}));}
          finally{cancelled.delete(id);}
        });
      };
    });
    await chrome.storage.local.set({profile,pairingCode:token});
    await chrome.action.setBadgeText({text:'ON'});
    await chrome.action.setBadgeBackgroundColor({color:'#4f6848'});
    heartbeat=setInterval(()=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'keepalive'}));},20000);
  }catch(e){await stop();throw e;}
}
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  (async()=>{
    await startupReady;
    if(message.type==='connect'){
      if(connecting)throw new Error('A connection is already in progress.');
      connecting=true;
      try{await connectTab(message.tabId,message.code);return {connected:true};}finally{connecting=false;}
    }
    if(message.type==='stop'){await stop();return {connected:false};}
    if(message.type==='status')return {connected:approved!==null&&socket?.readyState===WebSocket.OPEN,tab:approved!==null?await tabState():null,error:lastError};
    throw new Error('Unknown extension action.');
  })().then(reply).catch(e=>reply({error:String(e.message||e)}));return true;
});
chrome.debugger.onDetach.addListener(source=>{if(source.tabId===approved){lastError='Tab access was stopped in Chrome.';void stop();}});
chrome.tabs.onUpdated.addListener(tabId=>{if(tabId===approved&&socket?.readyState===WebSocket.OPEN)void tabState().then(tab=>socket?.send(JSON.stringify({type:'state',tab}))).catch(()=>stop());});
chrome.tabs.onRemoved.addListener(tabId=>{if(tabId===approved)void stop();});
// A service-worker restart requires fresh approval instead of adopting another tab.
const startupReady=chrome.storage.session.get('approvedTab').then(async({approvedTab})=>{if(approvedTab!==undefined)try{await chrome.debugger.detach({tabId:approvedTab});}catch{}await chrome.storage.session.remove('approvedTab');});
