'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const PROJECT=process.env.MATERIALS_PROJECT||path.resolve(__dirname,'../../..');
const {MaterialsManager}=require(path.join(PROJECT,'src/materials'));
const {ManagedManager}=require(path.join(PROJECT,'src/managed'));
const SECRET='QA_CLEANUP_PRIVATE_CONTENT_519',OWNER='qa-cleanup-alice',OTHER='qa-cleanup-bob';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function tmp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nocatch-cleanup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
function secure(){let decrypts=0;const key=crypto.createHash('sha256').update('QA OS encryption boundary').digest();return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'gnome_libsecret',encryptString(s){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(s),c.final(),c.getAuthTag()])},decryptString(b){decrypts++;const d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString()},get decrypts(){return decrypts}}}
test('failed encrypted deletion stays visible and cannot recover content after restart; explicit retry removes pending state',async t=>{
 const dir=tmp(t),safeStorage=secure(),states=[];const config={userDataPath:dir,safeStorage,owner:OWNER,onStatus:s=>states.push(s),extractor:async()=>({pages:[{text:SECRET}]})};
 const fixture=path.join(dir,'private.pdf');fs.writeFileSync(fixture,'%PDF-1.7 QA boundary fixture');const m=new MaterialsManager(config);t.after(()=>m.close());await m.importFiles([fixture]);await m.start({consent:true});const snap=m.snapshot();
 const db=m.store.db,exec=db.exec.bind(db);db.exec=function(sql){if(/DELETE\s+FROM/i.test(sql))throw Object.assign(Error('injected locked database'),{code:'SQLITE_BUSY'});return exec(sql)};
 const rm=fs.rmSync;let locked=true,attempts=0;fs.rmSync=function(file,...args){if(locked&&String(file).includes('session-materials.sqlite')){attempts++;throw Object.assign(Error('injected sharing violation'),{code:'EPERM'})}return rm.call(this,file,...args)};t.after(()=>{fs.rmSync=rm});
 await m.end();assert.equal(m.status().cleanupPending,true);assert.equal(m.retrieve(SECRET),null);assert.equal(m.isCurrent(snap),false);assert.ok(states.some(s=>s.cleanupPending),'pending cleanup must reach status observers');assert.equal(m.retryCleanup(),false);const count=attempts;await delay(80);assert.ok(attempts-count<=4,'failed cleanup must not spin');await m.close();
 const before=safeStorage.decrypts,n=new MaterialsManager(config);t.after(()=>n.close());await n.restore();assert.equal(safeStorage.decrypts,before,'pending deletion must gate recovery before OS decrypt');assert.equal(n.status().documents.length,0);assert.equal(n.status().cleanupPending,true);
 locked=false;assert.equal(n.retryCleanup(),true);assert.equal(n.status().cleanupPending,false);await n.close();const final=new MaterialsManager(config);t.after(()=>final.close());await final.restore();assert.equal(final.status().documents.length,0,'ended ciphertext cannot revive after successful retry');
});
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}});
async function managed(t,dir,{owner=OWNER,fail=true}={}){
 const config={issuer:'https://qa.identity.example',clientId:'cleanup-qa',apiBaseUrl:'https://qa.api.example',audience:'qa-api',scopes:['openid','answers:write']};fs.writeFileSync(path.join(dir,'managed-config.json'),JSON.stringify(config));
 const state={owner,fail,requests:[],hook:null};const manager=new ManagedManager({app:{isPackaged:true,getAppPath:()=>dir,getPath:()=>dir},safeStorage:{isEncryptionAvailable:()=>false},env:{},fetchImpl:async(url,init={})=>{
  if(url.endsWith('/.well-known/openid-configuration'))return json({issuer:config.issuer,authorization_endpoint:config.issuer+'/authorize',token_endpoint:config.issuer+'/token',code_challenge_methods_supported:['S256']});
  if(url.endsWith('/token'))return json({access_token:'QA_TOKEN_'+state.owner,token_type:'Bearer',expires_in:3600});
  if(url.endsWith('/v1/me'))return json({subject:state.owner,providers:['gemini'],limits:{},usage:{}});
  if(url.includes('/v1/material-sessions')){state.requests.push({url,method:init.method,body:init.body?JSON.parse(init.body):null,authorization:init.headers.Authorization});if(state.hook)await state.hook();if(state.fail)throw Error('injected offline');return json(init.body?JSON.parse(init.body):{success:true})}
  throw Error('Unexpected QA-only request '+url);
 },externalBrowser:async raw=>{const auth=new URL(raw),cb=new URL(auth.searchParams.get('redirect_uri'));cb.searchParams.set('state',auth.searchParams.get('state'));cb.searchParams.set('code','qa-code');assert.equal((await fetch(cb)).status,200)}});
 await manager.signIn();t.after(()=>manager.signOut());return {manager,state};
}
const session=(id='cleanup-session-01',deadline=Date.now()+60000,generation=1)=>({sessionId:id,expiresAt:deadline,generation});
async function settled(p){try{return await p}catch{return null}}
function metadata(dir){const p=path.join(dir,'material-cleanup.json');assert.ok(fs.existsSync(p),'retry metadata must survive restart');const raw=fs.readFileSync(p,'utf8');assert.ok(Buffer.byteLength(raw)<=65536);for(const needle of [SECRET,OWNER,OTHER,'QA_TOKEN_','private.pdf'])assert.ok(!raw.includes(needle),'queue leaked '+needle);return JSON.parse(raw)}
test('managed failed revision/end retains content-free metadata; terminal end supersedes revisions and preserves deadline',async t=>{
 const dir=tmp(t),{manager:m,state}=await managed(t,dir),s=session();await settled(m.syncMaterialSession({...s,text:SECRET,name:'private.pdf'}));assert.equal(m.status().materialCleanupPending,1);assert.equal(m.status().materialCleanupPersistent,true);metadata(dir);
 await settled(m.syncMaterialSession({...s,generation:3,expiresAt:s.expiresAt+30000}));await settled(m.endMaterialSession(s.sessionId,{expiresAt:s.expiresAt,generation:3}));await settled(m.syncMaterialSession({...s,generation:4}));assert.equal(m.status().materialCleanupPending,1);metadata(dir);
 state.requests=[];state.fail=false;await m.retryMaterialCleanup();assert.equal(m.status().materialCleanupPending,0);assert.equal(state.requests.length,1);assert.equal(state.requests[0].method,'DELETE');assert.ok(state.requests.every(r=>!JSON.stringify(r.body).includes(SECRET)));
});
test('managed revision retry uses newest generation but never extends original deadline',async t=>{
 const dir=tmp(t),{manager:m,state}=await managed(t,dir),s=session();await settled(m.syncMaterialSession(s));await settled(m.syncMaterialSession({...s,generation:5,expiresAt:s.expiresAt+30000}));await settled(m.syncMaterialSession({...s,generation:2}));state.requests=[];state.fail=false;await m.retryMaterialCleanup();assert.equal(state.requests.length,1);assert.equal(state.requests[0].body.generation,5);assert.equal(state.requests[0].body.expiresAt,s.expiresAt);assert.equal(m.status().materialCleanupPending,0);
});
test('managed pending cleanup survives restart and never dispatches under a different authenticated owner',async t=>{
 const dir=tmp(t),a=await managed(t,dir),s=session();await settled(a.manager.endMaterialSession(s.sessionId,{expiresAt:s.expiresAt,generation:2}));assert.equal(a.manager.status().materialCleanupPending,1);metadata(dir);await a.manager.signOut();
 const b=await managed(t,dir,{owner:OTHER,fail:false});await b.manager.retryMaterialCleanup();assert.equal(b.state.requests.length,0,'Bob must never send Alice cleanup using Bob auth');assert.equal(b.manager.status().materialCleanupPending,1);await b.manager.signOut();
 const again=await managed(t,dir,{fail:false});await again.manager.retryMaterialCleanup();assert.equal(again.state.requests.length,1);assert.equal(again.state.requests[0].method,'DELETE');assert.equal(again.state.requests[0].authorization,'Bearer QA_TOKEN_'+OWNER);assert.equal(again.manager.status().materialCleanupPending,0);
});
test('managed expired pending cleanup drops on restart without HTTP and retry attempts are bounded',async t=>{
 const dir=tmp(t),a=await managed(t,dir),s=session('cleanup-expiring',Date.now()+400);await settled(a.manager.endMaterialSession(s.sessionId,{expiresAt:s.expiresAt,generation:2}));const before=a.state.requests.length;await a.manager.retryMaterialCleanup();assert.ok(a.state.requests.length-before<=1,'one explicit drain gets one attempt per record');const after=a.state.requests.length;await delay(80);assert.equal(a.state.requests.length,after,'failed queue must not spin');await a.manager.signOut();await delay(Math.max(0,s.expiresAt-Date.now()+20));
 const b=await managed(t,dir,{fail:false});await b.manager.retryMaterialCleanup();assert.equal(b.state.requests.length,0);assert.equal(b.manager.status().materialCleanupPending,0);
});
test('managed pending cleanup is bounded to 64 metadata entries',async t=>{
 const dir=tmp(t),{manager:m}=await managed(t,dir),deadline=Date.now()+60000;for(let i=0;i<66;i++)await settled(m.endMaterialSession('cleanup-cap-'+i,{expiresAt:deadline,generation:1}));assert.ok(m.status().materialCleanupPending<=64);metadata(dir);
});
test('managed sign-out during a cleanup response prevents dispatch of the next queued owner record',async t=>{
 const dir=tmp(t),{manager:m,state}=await managed(t,dir),deadline=Date.now()+60000;for(const id of ['cleanup-race-a','cleanup-race-b'])await settled(m.endMaterialSession(id,{expiresAt:deadline,generation:1}));state.requests=[];state.fail=false;let fired=false;state.hook=async()=>{if(!fired){fired=true;await m.signOut()}};await settled(m.retryMaterialCleanup());assert.equal(state.requests.length,1,'sign-out must stop the batch before its next HTTP dispatch');assert.ok(m.status().materialCleanupPending>=1,'undelivered owner cleanup remains durable');metadata(dir);
});
