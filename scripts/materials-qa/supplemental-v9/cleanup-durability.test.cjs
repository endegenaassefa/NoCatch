'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const PROJECT=process.env.MATERIALS_PROJECT||path.resolve(__dirname,'../../..'),{MaterialsManager}=require(path.join(PROJECT,'src/materials'));
test('failed tombstone plus locked encrypted file reports nonpersistent cleanup until successful retry',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nocatch-cleanup-durability-')),states=[];t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const m=new MaterialsManager({userDataPath:dir,owner:'qa-marker-owner',safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},onStatus:s=>states.push(s),extractor:async()=>({pages:[{text:'QA_DURABILITY_PRIVATE_SENTINEL'}]})});t.after(()=>m.close());
 const file=path.join(dir,'qa.pdf');fs.writeFileSync(file,'%PDF-1.7 QA');await m.importFiles([file]);await m.start({consent:true});
 const exec=m.store.db.exec.bind(m.store.db);m.store.db.exec=sql=>{if(/DELETE FROM/.test(sql))throw Error('injected database locked');return exec(sql)};
 const write=fs.writeFileSync,rm=fs.rmSync;let blocked=true;
 fs.writeFileSync=(name,...args)=>{if(blocked&&String(name).endsWith('session-materials.cleanup'))throw Object.assign(Error('injected disk full'),{code:'ENOSPC'});return write(name,...args)};
 fs.rmSync=(name,...args)=>{if(blocked&&String(name).includes('session-materials.sqlite'))throw Object.assign(Error('injected sharing violation'),{code:'EPERM'});return rm(name,...args)};
 t.after(()=>{fs.writeFileSync=write;fs.rmSync=rm});
 await m.end();assert.equal(m.status().cleanupPending,true);assert.equal(m.status().cleanupPersistent,false);assert.ok(states.some(s=>s.cleanupPending&&s.cleanupPersistent===false),'nonpersistent pending state must reach observers');assert.equal(m.retrieve('PRIVATE'),null);assert.equal(m.status().documents.length,0);assert.equal(m.retryCleanup(),false);assert.equal(m.status().cleanupPersistent,false);
 blocked=false;assert.equal(m.retryCleanup(),true);assert.equal(m.status().cleanupPending,false);assert.equal(m.status().cleanupPersistent,true);assert.equal(fs.existsSync(path.join(dir,'session-materials.sqlite')),false);assert.equal(fs.existsSync(path.join(dir,'session-materials.cleanup')),false);
});
