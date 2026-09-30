'use strict';
// Standalone QA Electron entrypoint. Never loads production main.js or the installed profile.
const {app,BrowserWindow,ipcMain,session,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const PROJECT=process.env.MATERIALS_PROJECT||'/mnt/c/users/endeg/Desktop/NoCatch-session-materials';
const ROOT=__dirname,RESULTS=path.join(ROOT,'results');fs.mkdirSync(RESULTS,{recursive:true});
const PROFILE=fs.mkdtempSync(path.join(RESULTS,'native-profile-'));
app.setPath('userData',PROFILE);app.setName('NoCatch Materials Isolated QA');
const {MaterialsManager}=require(path.join(PROJECT,'src/materials'));
const {assertTrustedRenderer}=require(path.join(PROJECT,'src/core/trusted-renderer'));
let win,m,clock=Date.now(),pickerCalls=0;const report={profile:PROFILE,project:PROJECT,checks:[],platform:process.platform,electron:process.versions.electron};
const record=(name,data={})=>report.checks.push({name,...data});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(script,message){for(let i=0;i<150;i++){if(await win.webContents.executeJavaScript(script))return;await delay(100)}throw Error(message)}
const click=async pattern=>{const regex=new RegExp(pattern,'i');return win.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button,[role=button],a')].find(x=>!x.hidden&&new RegExp(${JSON.stringify(regex.source)},'i').test(x.textContent||x.getAttribute('aria-label')||''));if(!b)throw Error('Missing control: '+${JSON.stringify(pattern)});if(b.disabled)throw Error('Disabled control: '+b.textContent);b.click();return b.textContent})()`)};
function handler(name,fn){ipcMain.handle(name,async(event,...args)=>{assertTrustedRenderer(event,PROJECT);try{return {success:true,...await fn(...args)}}catch(error){return {success:false,error:{code:error.code||'QA_ERROR',message:error.message}}}})}
app.whenReady().then(async()=>{
 try{
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/i.test(details.url)}));
  m=new MaterialsManager({userDataPath:PROFILE,safeStorage,owner:'qa-native-isolated',now:()=>clock,onStatus:status=>{if(win&&!win.isDestroyed())win.webContents.send('materials-status-changed',status)}});
  await m.restore();
  handler('materials-status',()=>({status:m.status()}));
  handler('materials-import',async()=>{pickerCalls++;return {status:await m.importFiles([path.resolve(ROOT,'../fixtures/relationship-order-notes-visual.pptx'),path.resolve(ROOT,'../fixtures/three-pages.pdf'),path.resolve(ROOT,'../fixtures/corrupt.pdf')])}});
  handler('materials-start',async input=>({status:await m.start(input)}));
  handler('materials-preview',async(id,page)=>({preview:await m.preview(id,page)}));
  handler('materials-remove',async id=>{await m.remove(id);return {status:m.status()}});
  handler('materials-end',async()=>{await m.end('qa-renderer');return {status:m.status()}});
  handler('materials-cancel-import',async()=>{m.cancelImports();return {status:m.status()}});
  for(const name of ['materials-show','close-materials','show-main-window'])handler(name,async()=>({}));
  win=new BrowserWindow({show:true,width:950,height:820,webPreferences:{preload:path.join(PROJECT,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.on('console-message',(_event,...args)=>{report.console||=[];report.console.push(args.slice(0,3))});
  await win.loadFile(path.join(PROJECT,'materials.html'));
  await waitFor("document.querySelectorAll('button').length>0",'materials page did not initialize');
  record('real production materials.html and preload loaded');
  await click('add files|import materials|choose files');
  await waitFor("document.body.innerText.includes('relationship-order-notes-visual.pptx')&&document.body.innerText.includes('corrupt.pdf')",'document/error list missing');
  await waitFor("!document.querySelector('[aria-busy=true]')",'import never settled');
  assert.equal(pickerCalls,1);assert.equal(m.status().documents.filter(d=>!d.error&&d.pages).length,2);assert.equal(m.retrieve('Zephyr')?.sources?.length||0,0);
  assert.match(await win.webContents.executeJavaScript('document.body.innerText'),/partial|visual|image|coverage|not extracted/i);
  record('native parser workers imported PPTX/PDF and showed failure/coverage; no prestart context',{persistence:m.status().persistence});
  const consent=await win.webContents.executeJavaScript("(()=>{const c=[...document.querySelectorAll('input[type=checkbox]')].find(c=>!c.disabled);if(!c)return false;c.click();return c.checked})()");assert.equal(consent,true,'material sharing consent checkbox unavailable');
  await click('^start session$|^start.*90');
  await waitFor("/remaining|89:|90:|ends|active/i.test(document.body.innerText)",'active timer missing');assert.equal(m.status().state,'active');
  assert.ok(m.retrieve('Zephyr launch code').sources.some(s=>/MARIGOLD-629/.test(s.text)));
  record('consent starts real session and useful retrieval');
  await click('preview|open source|view source');
  await waitFor("/MARIGOLD-629|PDF_ONE_SENTINEL/.test(document.body.innerText)",'source preview text missing');
  fs.writeFileSync(path.join(RESULTS,'renderer-desktop.png'),await (await win.webContents.capturePage()).toPNG());record('source preview visible');
  win.setSize(390,820);await delay(250);
  const size=await win.webContents.executeJavaScript('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(size.scroll<=size.width+2,`horizontal overflow ${JSON.stringify(size)}`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await delay(50);
  const focused=await win.webContents.executeJavaScript('({tag:document.activeElement.tagName,text:document.activeElement.textContent})');assert.notEqual(focused.tag,'BODY');
  fs.writeFileSync(path.join(RESULTS,'renderer-narrow.png'),await (await win.webContents.capturePage()).toPNG());record('narrow layout and keyboard focus',{size,focused});
  await click('^remove$|remove document|remove material');
  await waitFor("!/MARIGOLD-629|PDF_ONE_SENTINEL/.test(document.body.innerText)",'removed source preview remains visible');
  assert.equal(m.status().documents.filter(d=>!d.error&&d.pages).length,1);record('remove clears preview and frees a document slot');
  // Expiry via injected public clock, then production status emits the invalidation to real renderer.
  clock=m.status().expiresAt;m.status();await delay(200);
  assert.equal(m.retrieve('Zephyr')?.sources?.length||0,0);
  await waitFor("!/MARIGOLD-629|PDF_ONE_SENTINEL/.test(document.body.innerText)",'expired source preview remains visible');record('exact expiry removes renderer source content');
  await click('add files|import materials|choose files');
  await waitFor("document.body.innerText.includes('relationship-order-notes-visual.pptx')",'new preparation after expiry missing');
  await waitFor("!document.querySelector('[aria-busy=true]')",'second import never settled');
  await win.webContents.executeJavaScript("(()=>{const c=[...document.querySelectorAll('input[type=checkbox]')].find(c=>!c.disabled);if(c&&!c.checked)c.click()})()");
  await click('^start session$|^start.*90');await delay(100);await click('^end session$');
  await delay(100);assert.equal(m.retrieve('Zephyr')?.sources?.length||0,0);assert.notEqual(m.status().state,'active');record('explicit end clears active material context');
  report.success=true;
 }catch(error){report.success=false;report.error=error.stack;try{if(win&&!win.isDestroyed()){report.visibleText=await win.webContents.executeJavaScript('document.body.innerText');fs.writeFileSync(path.join(RESULTS,'renderer-failure.png'),await (await win.webContents.capturePage()).toPNG())}}catch{}}
 finally{await m?.close();if(win&&!win.isDestroyed())win.destroy();fs.writeFileSync(path.join(RESULTS,'native-renderer-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({success:report.success,report:path.join(RESULTS,'native-renderer-report.json')}));app.exit(report.success?0:1)}
});
