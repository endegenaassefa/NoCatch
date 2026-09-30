'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{pathToFileURL}=require('node:url');
const {PROJECT,FIX,fixture}=require('../supplemental-v1/helpers.cjs');
const {assertTrustedRenderer}=require(path.join(PROJECT,'src/core/trusted-renderer'));
test('actual main material mutation IPC replies retain pending managed cleanup fields after broadcasts; legacy status is unchanged',async t=>{
 const f=await fixture(t),handlers=new Map(),broadcasts=[];let cancelledPicker=false;
 const electron={dialog:{showOpenDialog:async()=>({canceled:cancelledPicker,filePaths:[path.join(FIX,'three-pages.pdf')]})},BrowserWindow:{fromWebContents:()=>({})}};
 const context={Buffer,console,setTimeout,clearTimeout,setInterval,clearInterval,AbortController,process:{env:{}},path,require:id=>{if(id==='electron')return electron;throw Error('Unexpected dependency '+id)},ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}},app:{getAppPath:()=>PROJECT},assertTrustedRenderer};
 const source=fs.readFileSync(path.join(PROJECT,'main.js'),'utf8'),start=source.indexOf('class ApplicationController {'),end=source.indexOf('const gotSingleInstanceLock');assert.ok(start>=0&&end>start);
 const C=vm.runInNewContext(source.slice(start,end)+'\nApplicationController',context),c=Object.create(C.prototype),legacy={status:{legacySentinel:'must remain exact'}};
 Object.assign(c,{materialsManager:f.m,managedSession:{status:()=>({materialCleanupPending:2,materialCleanupPersistent:false})},getMaterialsOwner:()=> 'qa-alice',setupService:{getStatus:()=>legacy}});
 f.m.onStatus=status=>broadcasts.push(c.materialsStatus(status));c.setupIPCHandlers();const frame={url:pathToFileURL(path.join(PROJECT,'materials.html')).href},event={senderFrame:frame,sender:{mainFrame:frame}};
 const cases=[['materials-import',[]],['materials-start',[{consent:true}]],['materials-remove',[f.m.status().documents[0].id]],['materials-cancel-import',[]],['materials-end',[]]];
 for(const [channel,args] of cases){const result=await handlers.get(channel)(event,...args);assert.equal(result.success,true,channel);assert.equal(result.status.remoteCleanupPending,2,channel+' action reply must not erase the pending warning');assert.equal(result.status.remoteCleanupPersistent,false,channel+' must preserve nonpersistent retry warning');assert.ok(broadcasts.length>0);assert.equal(broadcasts.at(-1).remoteCleanupPending,2);assert.equal(broadcasts.at(-1).remoteCleanupPersistent,false)}
 cancelledPicker=true;const canceled=await handlers.get('materials-import')(event);assert.equal(canceled.status.remoteCleanupPending,2,'cancelled picker reply preserves server cleanup status');assert.equal(canceled.status.remoteCleanupPersistent,false);
 assert.equal(await handlers.get('get-setup-state')(event),legacy,'non-material channel result stays untouched');assert.equal(legacy.status.remoteCleanupPending,undefined);
});
