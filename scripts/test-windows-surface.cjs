'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
const {EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..');
async function create(platform,type){
  class BrowserWindow extends EventEmitter{
    constructor(options){super();this.options=options;this.bounds={width:options.width,height:options.height};this.webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){}});}
    loadFile(){return Promise.resolve();} setIgnoreMouseEvents(){} setMinimumSize(){} getSize(){return [this.bounds.width,this.bounds.height];}
  }
  const config={get:key=>key==='window.webPreferences'?{}:undefined};
  const box={module:{exports:{}},console,process:{platform,env:{}},require:key=>key==='electron'?{BrowserWindow}:key==='../core/logger'?{createServiceLogger:()=>new Proxy({},{get:()=>()=>{}})}:key==='../core/config'?config:require(key)};
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/managers/window.manager.js'),'utf8'),box);
  const m=box.module.exports;
  // Native positioning/topmost APIs are orthogonal to the compositor option boundary.
  m.positionWindow=()=>{};m.applyStealthMeasures=()=>{};
  return (await m.createWindow(type,false)).options;
}
for(const type of ['main','chat','llmResponse']){
  test(`Windows ${type} preserves the transparent resizable OpenCluely surface`,async()=>{
    const options=await create('win32',type);
    assert.equal(options.transparent,true,'the original overlay remains transparent');
    assert.equal(options.resizable,true,'user resizing remains available');
    if(type!=='chat') assert.equal(options.backgroundColor,'#00000000','original native backing stays transparent');
    assert.equal(options.frame,false);
  });
  test(`macOS ${type} retains existing transparent surface`,async()=>{
    const options=await create('darwin',type);assert.equal(options.transparent,true);
  });
}
