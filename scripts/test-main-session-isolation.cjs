'use strict';
// Independently authored adoption regression. Loads the real ApplicationController
// methods; only external provider/capture, window outputs and storage are fixtures.
// Reproduction: typed chat -> AI mode switch -> old provider delta/final reappears.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const events=[],memory=[],panels=[],requests=[],captureGate=deferred();let captureWait=false;
 const sessionManager={addUserInput:(text)=>memory.push({role:'user',text}),addModelResponse:text=>memory.push({role:'model',text}),addConversationEvent:event=>memory.push(event),clear:()=>{memory.length=0},getOptimizedHistory:()=>({recent:[]})};
 const invokeProvider=(...args)=>{const pending=deferred();requests.push({...pending,delta:args.at(-1)});return pending.promise};
 const context={Buffer,console,setTimeout,clearTimeout,process:{env:{}},config:{get:()=> 'both'},
  logger:{info(){},warn(){},error(){},debug(){}},sessionManager,
  llmService:{processTextWithSkillStream:invokeProvider,processImageWithSkillStream:invokeProvider},
  captureService:{captureAndProcess:async()=>{if(captureWait)await captureGate.promise;return {imageBuffer:Buffer.from('fixture-image'),mimeType:'image/png'}}},
  speechService:{cancelRecording(){}},windowManager:{broadcastToAllWindows:(channel,data)=>events.push({channel,data}),showLLMLoading:()=>panels.push('loading'),showLLMResponse:text=>panels.push(text),hideLLMResponse:()=>panels.push('hidden')}};
 const source=fs.readFileSync(path.join(root,'main.js'),'utf8');const start=source.indexOf('class ApplicationController {'),end=source.indexOf('const gotSingleInstanceLock');assert(start>=0&&end>start,'real controller source found');
 const Controller=vm.runInNewContext(source.slice(start,end)+'\nApplicationController',context);const c=Object.create(Controller.prototype);
 Object.assign(c,{operationEpoch:0,activeSkill:'dsa',codingLanguage:'JavaScript',isReady:true,setupService:{invalidate(){}},managedSession:{cancelAll:async()=>{},status:()=>({signingIn:false})}});
 return {c,events,memory,panels,requests,captureGate,setCaptureWait:()=>{captureWait=true},clearOutputs(){events.length=0;memory.length=0;panels.length=0}};
}
const finish=r=>{r.delta('fixture delta');r.resolve({response:'fixture answer',metadata:{processingTime:1,usedFallback:false}})};
for(const surface of ['text','screenshot']){
 const start=f=>surface==='text'?f.c.processWithLLM('question',{recent:[]}):f.c.triggerScreenshotOCR();
 test(`${surface}: current response streams, persists and displays`,async()=>{const f=fixture(),pending=start(f);await tick();assert.equal(f.requests.length,1);finish(f.requests[0]);await pending;assert(f.events.some(e=>e.channel==='transcription-llm-response-chunk'));assert(f.events.some(e=>e.channel==='transcription-llm-response'));assert(f.memory.some(e=>e.role==='model'&&e.text==='fixture answer'));assert(f.panels.includes('fixture answer'));});
 for(const outcome of ['success','failure'])test(`${surface}: mode/account invalidation discards late ${outcome} and preserves current UI`,async()=>{const f=fixture(),pending=start(f);await tick();assert.equal(f.requests.length,1);await f.c.invalidateManagedWork();f.clearOutputs();f.panels.push('new session panel');if(outcome==='success')finish(f.requests[0]);else f.requests[0].reject(Error('old provider error'));await pending;assert.deepEqual(f.events,[],'stale result/error must not broadcast');assert.deepEqual(f.memory,[],'stale result/error must not enter new history');assert.deepEqual(f.panels,['new session panel'],'stale cleanup must not hide/replace new UI');});
 test(`${surface}: global session clear discards pending output`,async()=>{const f=fixture(),pending=start(f);await tick();f.c.clearSessionMemory();f.clearOutputs();finish(f.requests[0]);await pending;assert.deepEqual(f.events,[]);assert.deepEqual(f.memory,[]);assert.deepEqual(f.panels,[]);});
}
test('screenshot: mode/account change while capture waits prevents provider dispatch',async()=>{const f=fixture();f.setCaptureWait();const pending=f.c.triggerScreenshotOCR();await tick();await f.c.invalidateManagedWork();f.clearOutputs();f.captureGate.resolve();await tick();const sent=f.requests.length;if(sent)finish(f.requests[0]);await pending;assert.equal(sent,0,'old screenshot must not cross provider boundary under new account');assert.deepEqual(f.events,[]);assert.deepEqual(f.memory,[]);assert.deepEqual(f.panels,[]);});
