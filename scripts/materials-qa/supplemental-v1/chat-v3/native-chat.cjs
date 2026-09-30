'use strict';
const {app,BrowserWindow,ipcMain,session}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const PROJECT=process.env.MATERIALS_PROJECT||'/mnt/c/users/endeg/Desktop/NoCatch-session-materials',ROOT=__dirname,RESULTS=path.join(ROOT,'results');fs.mkdirSync(RESULTS,{recursive:true});const profile=fs.mkdtempSync(path.join(RESULTS,'chat-profile-'));app.setPath('userData',profile);app.setName('NoCatch Isolated Chat QA');
const {assertTrustedRenderer}=require(path.join(PROJECT,'src/core/trusted-renderer'));
let win,resolveStatus,holdStatus=false;const report={profile,project:PROJECT,checks:[],platform:process.platform,electron:process.versions.electron,sourceHashes:Object.fromEntries(['chat.html','preload.js','src/ui/materials-links.js'].map(n=>[n,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(PROJECT,n))).digest('hex')]))};
const marker={sessionId:'qa-material-session',generation:1,expiresAt:Date.now()+90*60000};
let status={state:'idle',id:null,generation:0,expiresAt:null,persistence:'memory-only',documents:[],busy:false,limits:{}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const js=script=>win.webContents.executeJavaScript(script);
const emit=(name,data)=>win.webContents.send(name,data);
const text=()=>js('document.body.innerText');
async function waitFor(script,message){for(let i=0;i<100;i++){if(await js(script))return;await delay(50)}throw Error(message)}
async function noStorage(){const entries=await js('Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]))');assert.doesNotMatch(JSON.stringify(entries),/QA_SECRET_|QA_LEGACY_SECRET/,'material or legacy secret remains in localStorage');assert.doesNotMatch(JSON.stringify(entries).replace(/_/g,''),/QASECRET|QALEGACYSECRET/,'rendered material secret remains in localStorage');return entries}
function final(id,secret){emit('transcription-llm-response-start',{messageId:id,requestId:id,skill:'general',materialSession:marker});emit('transcription-llm-response-chunk',{messageId:id,requestId:id,delta:secret,materialSession:marker});emit('transcription-llm-response',{messageId:id,requestId:id,response:secret,materialSession:marker,metadata:{messageId:id,requestId:id,materialSession:marker,sources:[{id:'qa-source',documentId:'qa-doc',name:'Safety.pptx',page:2,kind:'slide'}]}})}
app.whenReady().then(async()=>{
 try{
  session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:/^https?:/i.test(d.url)}));
  const handle=(name,fn)=>ipcMain.handle(name,(event,...args)=>{assertTrustedRenderer(event,PROJECT);return fn(...args)});
  handle('materials-status',()=>holdStatus?new Promise(r=>resolveStatus=r):({success:true,status}));
  handle('get-speech-availability',()=>true);handle('get-settings',()=>({activeSkill:'general'}));handle('get-exam-mode-state',()=>({active:false}));handle('get-window-stats',()=>({}));handle('get-capture-mode',()=>({active:false}));handle('get-window-binding-status',()=>({bound:false}));handle('shield-status',()=>({running:false}));handle('get-shortcut-status',()=>({}));handle('get-session-history',()=>[]);handle('get-llm-session-history',()=>[]);
  handle('send-chat-message',async(_question,id)=>{final(id,'QA_SECRET_TYPED_583');return {success:true}});
  for(const name of ['resize-window','move-window','close-window','set-window-binding','show-settings','update-active-skill','clear-session-memory','materials-show'])handle(name,()=>({success:true}));
  win=new BrowserWindow({show:true,width:820,height:760,webPreferences:{preload:path.join(PROJECT,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await win.loadFile(path.join(PROJECT,'chat.html'));await delay(200);
  await js("localStorage.setItem('sru_chat_history_v1',JSON.stringify([{kind:'message',type:'assistant',text:'QA_LEGACY_SECRET'}]))");
  holdStatus=true;await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload()});await delay(100);
  assert.doesNotMatch(await text(),/QA_LEGACY_SECRET/,'legacy history rendered before initial materials status resolved');
  final('race-request','QA_SECRET_RACE_172');await delay(150);await noStorage();
  report.checks.push('provider start marker suppresses persistence before initial status reply');
  status={...status,state:'active',id:marker.sessionId,generation:marker.generation,expiresAt:marker.expiresAt,documents:[{id:'qa-doc',name:'Safety.pptx',state:'ready',pages:2}]};holdStatus=false;assert.ok(resolveStatus,'renderer never requested initial material status');resolveStatus({success:true,status});emit('materials-status-changed',status);await delay(150);await noStorage();
  await js("(()=>{const i=document.getElementById('messageInput');i.value='QA_SECRET_TYPED_QUESTION';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('sendButton').click()})()");
  await waitFor("document.body.innerText.replace(/_/g,'').includes('QASECRETTYPED583')",'typed material response did not render');await noStorage();report.checks.push('typed material question and answer stay out of localStorage');
  emit('transcription-received',{text:'QA_SECRET_VOICE_QUESTION',isFinal:true});final('voice-request','QA_SECRET_VOICE_632');await waitFor("document.body.innerText.replace(/_/g,'').includes('QASECRETVOICE632')",'voice material response did not render');await noStorage();report.checks.push('voice material answer stays out of localStorage');
  emit('chat-request-started',{requestId:'image-request',kind:'capture',materialSession:marker});final('image-request','QA_SECRET_IMAGE_745');await waitFor("document.body.innerText.replace(/_/g,'').includes('QASECRETIMAGE745')",'image material response did not render');await noStorage();report.checks.push('screenshot material answer stays out of localStorage');
  fs.writeFileSync(path.join(RESULTS,'chat-active.png'),await (await win.webContents.capturePage()).toPNG());
  for(const reason of ['remove','owner','end','expired']){
   await js("document.getElementById('messageInput').value='QA_SECRET_UNSENT_DRAFT'");
   emit('materials-session-invalidated',{reason,sessionId:marker.sessionId,generation:marker.generation+1});emit('session-cleared');
   status={...status,state:'idle',id:null,documents:[],expiresAt:null,generation:status.generation+1};emit('materials-status-changed',status);await delay(100);
   assert.doesNotMatch((await text()).replace(/_/g,''),/QASECRET|QALEGACYSECRET/,'invalidation retained material DOM');assert.equal(await js("document.getElementById('messageInput').value"),'','invalidation retained unsent draft');await noStorage();
   // Even after status becomes idle this launch must never re-enable durable history.
   emit('transcription-llm-response',{response:'QA_SECRET_AFTER_INVALIDATION_'+reason,metadata:{}});await delay(100);await noStorage();
   report.checks.push(`${reason} clears DOM/draft and persistence stays disabled for launch`);
  }
  fs.writeFileSync(path.join(RESULTS,'chat-cleared.png'),await (await win.webContents.capturePage()).toPNG());report.success=true;
 }catch(error){report.success=false;report.error=error.stack;try{report.visibleText=await text();report.storage=await js('Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]))');fs.writeFileSync(path.join(RESULTS,'chat-failure.png'),await (await win.webContents.capturePage()).toPNG())}catch{}}
 finally{if(win&&!win.isDestroyed())win.destroy();fs.writeFileSync(path.join(RESULTS,'native-chat-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({success:report.success,report:path.join(RESULTS,'native-chat-report.json')}));app.exit(report.success?0:1)}
});
