'use strict';
// Independent QA: real production methods, external capture/storage/provider fixtures.
const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..'), quiet=new Proxy({},{get:()=>()=>{}});
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
function speech(){
 const box={module:{exports:{}},console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,process:{platform:'win32',env:{}},require:n=>n==='../core/logger'?{createServiceLogger:()=>quiet}:n==='../core/config'?{get:()=>undefined}:n==='./whisper-worker.service'?class{isConfigured(){return false}close(){}releaseWhenIdle(){}}:n==='../core/whisper-runtime'?{}:n==='microsoft-cognitiveservices-speech-sdk'||n==='node-record-lpcm16'?{}:require(n)};
 const source=fs.readFileSync(path.join(root,'src/services/speech.service.js'),'utf8').replace('module.exports = new SpeechService();','module.exports = SpeechService;');
 vm.runInNewContext(source,box);const s=Object.create(box.module.exports.prototype);EventEmitter.call(s);
 Object.assign(s,{isRecording:false,available:true,provider:'whisper',runtimeSettings:{},whisperCommand:{kind:'fixture'},whisperWorker:{isConfigured:()=>false,close(){},releaseWhenIdle(){}},segmentBuffers:[],segmentBytes:0});
 s.on('error',()=>{});s._isManualCaptureMode=()=>true;s._getWhisperModel=()=> 'tiny.en';
 const waits=[];s.rendererCapture={start(){const g=gate();waits.push(g);return g.promise},cancel(){},stop:async()=>({})};
 const starts=[];s.on('recording-started',()=>starts.push({ready:s._captureReady,generation:s._generation}));return {s,waits,starts};
}

function controllerFor(s){const context={speechService:s,windowManager:{showChatWindow(){},broadcastToAllWindows(){}},logger:quiet,process:{env:{}},console};const code=fs.readFileSync(path.join(root,'main.js'),'utf8');const C=vm.runInNewContext(code.slice(code.indexOf('class ApplicationController {'),code.indexOf('const gotSingleInstanceLock'))+'\nApplicationController',context);return Object.create(C.prototype)}
const tick=()=>new Promise(r=>setImmediate(r));
test('status explicitly distinguishes pending model preparation from active recording',async()=>{const f=speech(),model=gate();f.s.whisperCommand={kind:'bundled'};f.s.modelPreparation={isReady:()=>true,requireReady:()=>model.promise};const pending=f.s.startRecording();try{await tick();assert.equal(f.s.getStatus().isStarting,true);assert.equal(f.s.isRecording,false);}finally{f.s.cancelRecording();model.resolve(path.resolve('fixture-model.pt'));await pending}});
test('second controller toggle during model preparation cancels and prevents late acquisition',async()=>{const f=speech(),model=gate();f.s.whisperCommand={kind:'bundled'};f.s.modelPreparation={isReady:()=>true,requireReady:()=>model.promise};f.s.isAvailable=()=>true;const c=controllerFor(f.s);c.toggleSpeechRecognition();const pending=f.s._preparingRecordingPromise;try{await tick();c.toggleSpeechRecognition();model.resolve(path.resolve('fixture-model.pt'));await tick();const acquisitions=f.waits.length;for(const w of f.waits)w.resolve();await pending;assert.equal(acquisitions,0,'cancelled preparation must never ask for a microphone');assert.equal(f.starts.length,0);assert.equal(f.s.getStatus().isStarting,false);}finally{f.s.cancelRecording();model.resolve(path.resolve('fixture-model.pt'))}});
test('pending microphone acquisition reports starting and second toggle cancels owned start',async()=>{const f=speech();f.s.isAvailable=()=>true;const c=controllerFor(f.s);c.toggleSpeechRecognition();const pending=f.s._startPromise;try{assert.equal(f.s.getStatus().isStarting,true);c.toggleSpeechRecognition();f.waits[0].resolve();await pending;assert.equal(f.starts.length,0);assert.equal(f.s.isRecording,false);assert.equal(f.s.getStatus().isStarting,false);}finally{f.s.cancelRecording()}});
