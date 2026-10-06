'use strict';
// Independent behavior checks execute complete production WindowManager and ExamLayout.
// Electron windows, displays, shortcut registration and disk are controlled boundaries.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),{EventEmitter}=require('events');
if (!process.argv[2] || !process.argv[3]) { console.error('Usage: node review-regressions.cjs PROJECT_ROOT EVIDENCE_DIR'); process.exit(2); }
const ROOT=path.resolve(process.argv[2]), OUT=path.resolve(process.argv[3]);fs.mkdirSync(OUT,{recursive:true});
const records=[];const hash=require('crypto').createHash;const sourceHashes={};
function fixture({saved,conflict,deferMainLoad=false,nativeOvershoot=0,area={x:0,y:0,width:1600,height:1000}}={}) {
 let releaseMain;let timers=[],windows=[],shortcuts=new Map(),writes=[],errors=[],displays=[{id:1,workArea:area,scaleFactor:1}];
 const later=(f,ms,...args)=>{let t=setTimeout(()=>f(...args),ms);t.unref();timers.push(t);return t;};
 class W extends EventEmitter {
  constructor(o){super();this.options=o;this.id=windows.length+1;this.visible=!!o.show;this.bounds={x:0,y:0,width:o.width,height:o.height};this.movable=o.movable!==false;this.resizable=o.resizable!==false;this.webContents=new EventEmitter();Object.assign(this.webContents,{send:(n,d)=>{this.events.push([n,d]);},isDestroyed:()=>false,setWindowOpenHandler(){},getURL:()=>this.file||''});this.events=[];windows.push(this);}
  static getAllWindows(){return windows.filter(w=>!w.destroyed)}
  async loadFile(f){this.file=f;if(deferMainLoad&&f==='index.html')await new Promise(r=>{releaseMain=r});this.webContents.emit('did-finish-load');}
  isDestroyed(){return !!this.destroyed} isVisible(){return this.visible} isFocused(){return false} isMinimized(){return false}
  showInactive(){if(!this.visible){this.visible=true;this.emit('show')}} show(){this.showInactive()} hide(){if(this.visible){this.visible=false;this.emit('hide')}}
  destroy(){this.visible=false;this.destroyed=true;this.emit('closed')} focus(){this.focused=(this.focused||0)+1}
  getBounds(){return {...this.bounds}} getPosition(){return [this.bounds.x,this.bounds.y]} getSize(){return [this.bounds.width,this.bounds.height]} getContentSize(){return this.getSize()}
  setBounds(b){Object.assign(this.bounds,b);if(nativeOvershoot&&b.width!==undefined)this.bounds.width=b.width+nativeOvershoot;this.emit('move');this.emit('resize')} setPosition(x,y){this.setBounds({x,y})} setSize(width,height){this.setBounds({width,height})} setContentSize(w,h){this.setSize(w,h)}
  setMinimumSize(...v){this.min=v} setMaximumSize(...v){this.max=v} setMovable(v){this.movable=v} setResizable(v){this.resizable=v}
  setAlwaysOnTop(v){this.topmost=v} isAlwaysOnTop(){return this.topmost} setVisibleOnAllWorkspaces(){} setIgnoreMouseEvents(){} setSkipTaskbar(){} setContentProtection(){} setTitle(){} moveTop(){} setFocusable(){}
 }
 const screen=Object.assign(new EventEmitter(),{getAllDisplays:()=>displays,getPrimaryDisplay:()=>displays[0],getDisplayMatching:()=>displays[0],getDisplayNearestPoint:()=>displays[0],getCursorScreenPoint:()=>({x:100,y:100})});
 const electron={BrowserWindow:W,screen,app:{getPath:()=>OUT,getAppPath:()=>ROOT},globalShortcut:{register:(k,f)=>{if(k===conflict)return false;shortcuts.set(k,f);return true},unregister:k=>shortcuts.delete(k),isRegistered:k=>shortcuts.has(k)}};
 const log={debug(){},info(){},warn(){},error:(...x)=>errors.push(x)};
 const disk={...fs,readFileSync:()=>{if(saved)return JSON.stringify(saved);throw Object.assign(Error('missing'),{code:'ENOENT'})},mkdirSync(){},writeFileSync:(p,x)=>writes.push(x),renameSync(){}};
 function load(rel){const file=path.join(ROOT,rel),src=fs.readFileSync(file,'utf8');sourceHashes[rel]=hash('sha256').update(src).digest('hex');const ctx={module:{exports:{}},__dirname:path.dirname(file),console,Buffer,process:{platform:'win32',pid:123,env:{},argv:[]},setTimeout:later,clearTimeout,setInterval:(f,ms)=>later(f,ms),clearInterval,require:n=>n==='electron'?electron:n.includes('core/logger')?{createServiceLogger:()=>log}:n.includes('core/config')?{get:k=>k==='window.webPreferences'?{}:undefined}:n==='node:fs'||n==='fs'?disk:n==='./exam-layout'?load('src/managers/exam-layout.js'):require(n)};vm.runInNewContext(src,ctx,{filename:file});return ctx.module.exports;}
 const m=load('src/managers/window.manager.js');m.initializeExamLayout({enabled:true});
 return {releaseMain:()=>releaseMain(),m,shortcuts,writes,errors,screen,windows,async boot(){await m.initializeWindows();},get main(){return m.getWindow('main')},get chat(){return m.getWindow('chat')},display(a){displays=[{id:2,workArea:a,scaleFactor:1.5}];m.examLayout.fit();},cleanup(){m.examLayout.dispose();for(const t of timers)clearTimeout(t)}};
}
async function run(name,fn,opts){let f;try{f=fixture(opts);if(!opts?.manualBoot)await f.boot();await fn(f);records.push({name,pass:true});}catch(e){records.push({name,pass:false,error:e.stack});}finally{f?.cleanup()}console.log(records.at(-1).pass?'PASS':'FAIL',name)}
const eq=(a,b,msg)=>assert.equal(a,b,msg), rect=w=>({...w.getBounds()}), shape=f=>[f.main.isVisible(),f.chat.isVisible()];
(async()=>{
 await run('R11 hide during pending main load wins over startup',async f=>{const pending=f.boot();await Promise.resolve();eq(f.windows.length,1);f.m.hideAllWindowsExcept([]);f.releaseMain();await pending;assert.deepEqual(shape(f),[false,false]);},{deferMainLoad:true,manualBoot:true});
 await run('R8 movement retains native size correction',f=>{f.m.showChatWindow();const before=[rect(f.main),rect(f.chat)];for(let i=0;i<4;i++){f.shortcuts.get('Ctrl+Shift+Left')();eq(f.main.getBounds().width,before[0].width,'toolbar width correction retained');eq(f.chat.getBounds().width,before[1].width,'chat width correction retained');}},{nativeOvershoot:1});
 await run('R9 extreme work area menu scrollport fits',f=>{const state=f.m.examLayout.state();const top=state.menuTop??state.compactHeight+8;assert(top>=0&&state.menuMaxHeight>0&&top+state.menuMaxHeight<=60,'published menu scrollport must fit actual available work area');},{area:{x:0,y:0,width:300,height:60}});
 fs.writeFileSync(path.join(OUT,'boundary-results.json'),JSON.stringify({source:ROOT,sourceHashes,scope:'Supplemental reviewer hypotheses through full production modules; OS boundaries controlled.',records},null,2));process.exitCode=records.some(r=>!r.pass)?1:0;
})();
