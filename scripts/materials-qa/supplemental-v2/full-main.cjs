'use strict';
// Isolation bootstrap + real production main, not a replacement ApplicationController.
const electron=require('electron'),{app,BrowserWindow,session}=electron,fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const ROOT=__dirname,RESULTS=path.join(ROOT,'results'),PROJECT=process.env.MATERIALS_PROJECT;
if(!PROJECT||!path.isAbsolute(PROJECT))throw Error('Set MATERIALS_PROJECT to an absolute worktree or app.asar path.');
fs.mkdirSync(RESULTS,{recursive:true});const phase=process.env.MATERIALS_QA_PHASE==='returning'?'returning':'first-run';
const profile=fs.mkdtempSync(path.join(RESULTS,`full-main-${phase}-`));
const dirs={userData:profile,sessionData:path.join(profile,'chromium'),appData:path.join(profile,'appData'),temp:path.join(profile,'tmp'),logs:path.join(profile,'logs'),crashDumps:path.join(profile,'crashes')};
for(const [name,dir] of Object.entries(dirs)){fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir)}
app.setAppPath(PROJECT);os.homedir=()=>profile;os.tmpdir=()=>dirs.temp;
process.chdir(profile);
for(const key of Object.keys(process.env))if(/(?:API.?KEY|SECRET|TOKEN|PASSWORD|^AZURE_|^GEMINI_|^DEEPSEEK_|^WHISPER_|^NOCATCH_MANAGED_|^CLUELY_)/i.test(key))delete process.env[key];
process.env.AI_MODE='direct';process.env.SPEECH_PROVIDER='disabled';process.env.LOG_LEVEL='warn';
process.env.CLUELY_SHIELD_SOCKET=path.join(profile,'no-shield.sock');
fs.writeFileSync(path.join(profile,'.env'),'AI_MODE=direct\nSPEECH_PROVIDER=disabled\n');
if(phase==='returning')fs.writeFileSync(path.join(profile,'setup-state.json'),JSON.stringify({version:1,completed:true,step:'complete',draft:'',inputMode:'text'}));
// The only application module seam replaced is external privilege detection. It prevents fixed
// elevated C:\ProgramData\CluelyRoot initialization before first main statement reaches storage.
const privilege=require(path.join(PROJECT,'src/platform/privilege'));privilege.detect=()=>({platform:process.platform,isRoot:false,integrity:'qa-isolated',method:'qa-boundary',detail:'QA nonroot boundary; OS privilege not tested'});
privilege.rootDataDir=()=>{throw Error('QA prohibits production elevated root data access')};
const allowed=path.resolve(RESULTS).toLowerCase()+path.sep;
const allowWrite=p=>{if(typeof p==='number')return;if(p instanceof URL)p=require('node:url').fileURLToPath(p);const r=path.resolve(String(p)).toLowerCase();if(r!==path.resolve(RESULTS).toLowerCase()&&!r.startsWith(allowed))throw Error('QA denied filesystem write outside results: '+r)};
for(const key of ['writeFile','writeFileSync','appendFile','appendFileSync','mkdir','mkdirSync','unlink','unlinkSync','rm','rmSync','rmdir','rmdirSync','truncate','truncateSync','createWriteStream']){const original=fs[key];if(original)fs[key]=function(p,...args){allowWrite(p);return original.call(this,p,...args)}}
for(const key of ['rename','renameSync']){const original=fs[key];fs[key]=function(a,b,...args){allowWrite(a);allowWrite(b);return original.call(this,a,b,...args)}}
for(const key of ['copyFile','copyFileSync']){const original=fs[key];fs[key]=function(a,b,...args){allowWrite(b);return original.call(this,a,b,...args)}}
for(const key of ['open','openSync']){const original=fs[key];fs[key]=function(p,flags,...args){if(typeof flags==='string'?/[wa+]/.test(flags):Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT)))allowWrite(p);return original.call(this,p,flags,...args)}}
for(const key of ['writeFile','appendFile','mkdir','unlink','rm','rmdir','truncate']){const original=fs.promises[key];if(original)fs.promises[key]=function(p,...args){allowWrite(p);return original.call(this,p,...args)}}
for(const key of ['rename','copyFile']){const original=fs.promises[key];fs.promises[key]=function(a,b,...args){if(key==='rename')allowWrite(a);allowWrite(b);return original.call(this,a,b,...args)}}
const deniedNetwork=()=>{throw Error('QA network disabled')};
for(const name of ['node:http','node:https']){const mod=require(name);mod.request=deniedNetwork;mod.get=deniedNetwork}
require('node:net').Socket.prototype.connect=deniedNetwork;globalThis.fetch=async()=>deniedNetwork();electron.net.fetch=async()=>deniedNetwork();electron.shell.openExternal=async()=>deniedNetwork();
const shortcuts=new Set();electron.globalShortcut.register=k=>{shortcuts.add(k);return true};electron.globalShortcut.isRegistered=k=>shortcuts.has(k);electron.globalShortcut.unregister=k=>shortcuts.delete(k);electron.globalShortcut.unregisterAll=()=>shortcuts.clear();
electron.desktopCapturer.getSources=async()=>[];
let pickerCalls=0;electron.dialog.showOpenDialog=async()=>{pickerCalls++;return {canceled:false,filePaths:[path.resolve(ROOT,'../fixtures/relationship-order-notes-visual.pptx'),path.resolve(ROOT,'../fixtures/three-pages.pdf')]}};
const report={phase,project:PROJECT,profile,checks:[],limitations:['OS privilege/global shortcuts/screen capture/dialog result/network are external boundary stubs','No live account/provider or elevated-mode claim'],electron:process.versions.electron,errors:[]};
app.on('web-contents-created',(_event,wc)=>{wc.on('preload-error',(_event,_file,error)=>report.errors.push(error.message));wc.on('render-process-gone',(_event,detail)=>report.errors.push(detail.reason))});
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:/^https?:/i.test(d.url)})));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const windows=()=>BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed());
const page=name=>windows().find(w=>w.webContents.getURL().split(/[?#]/)[0].endsWith('/'+name));
async function wait(fn,reason){for(let i=0;i<200;i++){if(await fn())return;await delay(100)}throw Error(reason)}
const invoke=(win,code)=>win.webContents.executeJavaScript(code,true);
let ending=false;async function finish(success,error){if(ending)return;ending=true;report.success=success;if(error)report.error=error.stack;report.windows=windows().map(w=>({url:w.webContents.getURL(),visible:w.isVisible()}));try{const w=page('materials.html')||page('onboarding.html');if(w)fs.writeFileSync(path.join(RESULTS,`full-main-${phase}.png`),await(await w.webContents.capturePage()).toPNG())}catch{}fs.writeFileSync(path.join(RESULTS,`full-main-${phase}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({success,phase,profile}));app.exit(success?0:1)}
const timeout=setTimeout(()=>finish(false,Error('Full main QA timeout')),55000);
require(path.join(PROJECT,'main.js'));
app.whenReady().then(async()=>{try{
 await wait(()=>windows().length>=5&&windows().every(w=>w.webContents.getURL().startsWith('file:')&&!w.webContents.isLoading()),'main windows failed to load');
 assert.equal(app.getPath('userData'),profile);assert.equal(os.homedir(),profile);assert.deepEqual(report.errors,[]);
 for(const name of ['index.html','onboarding.html','chat.html','settings.html','llm-response.html'])assert.ok(page(name),`Missing ${name}`);
 report.checks.push('actual production main starts five inherited windows under isolated profile');
 if(phase==='first-run'){
  const onboarding=page('onboarding.html');await wait(()=>onboarding.isVisible(),'first-run onboarding not shown');
  assert.equal(await invoke(onboarding,"(()=>{const b=document.getElementById('materials-button');return !!b&&/materials/i.test(b.textContent)})()"),true);
  await invoke(onboarding,"document.getElementById('materials-button').click()");report.checks.push('first-run optional materials button invokes real main IPC');
 }else report.checks.push('returning setup completion loaded from disposable profile');
 await wait(()=>Boolean(page('materials.html'))&&!page('materials.html').webContents.isLoading()&&page('materials.html').isVisible(),'materials window not shown');
 const materials=page('materials.html');assert.ok(windows().length>=6);report.checks.push('sixth materials window opens including returning launch');
 const imported=await invoke(materials,'window.electronAPI.importMaterials()');assert.equal(imported.success,true,JSON.stringify(imported));assert.equal(pickerCalls,1);assert.equal(imported.status.documents.filter(d=>!d.error&&d.pages).length,2);assert.equal(imported.status.persistence,'encrypted');report.checks.push('real trusted main file picker handler imports PPTX/PDF through native workers encrypted');
 const started=await invoke(materials,'window.electronAPI.startMaterials({consent:true})');assert.equal(started.success,true,JSON.stringify(started));assert.equal(started.status.state,'active');const doc=started.status.documents.find(d=>/pptx$/.test(d.name));
 const preview=await invoke(materials,`window.electronAPI.previewMaterial(${JSON.stringify(doc.id)},1)`);assert.equal(preview.success,true);assert.match(JSON.stringify(preview.preview),/MARIGOLD-629/);report.checks.push('real main start/preview retain actual relationship source');
 const ended=await invoke(materials,'window.electronAPI.endMaterials()');assert.equal(ended.success,true);const after=await invoke(materials,'window.electronAPI.getMaterialsStatus()');assert.notEqual(after.status.state,'active');assert.equal(after.status.documents.filter(d=>!d.error&&d.pages).length,0);report.checks.push('real main end clears session material state');
 assert.deepEqual(report.errors,[]);clearTimeout(timeout);await finish(true);
 }catch(error){clearTimeout(timeout);await finish(false,error)}});
