'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),quiet=new Proxy({},{get:()=>()=>{}});
function llm(){
 const sandbox={module:{exports:{}},Buffer,console,process:{env:{}},require:n=>n==='@google/genai'?{}:n==='../core/logger'?{createServiceLogger:()=>quiet}:n==='../core/config'?{get:k=>k.endsWith('fallbackEnabled')?true:undefined}:n==='../../prompt-loader'?require('../prompt-loader'):n==='./deepseek.client'?require('../src/services/deepseek.client'):require(n)};
 const source=fs.readFileSync(path.join(root,'src/services/llm.service.js'),'utf8').replace(/module\.exports = new LLMService\(\);/,'module.exports = LLMService;');vm.runInNewContext(source,sandbox);
 const s=Object.create(sandbox.module.exports.prototype);Object.assign(s,{provider:'deepseek',isInitialized:true,requestCount:0,errorCount:0});return s;
}

test('partial image stream followed by stream and retry failure rejects without a successful fallback',async()=>{
 const s=llm(),deltas=[];s._executeStreaming=async(_request,onDelta)=>{onDelta('Incomplete fixture response');throw Error('fixture stream interrupted')};s._executeDeepSeek=async()=>{throw Error('fixture retry unavailable')};
 await assert.rejects(s.processImageWithSkillStream(Buffer.from('fixture-image'),'image/png','dsa',[],'cpp',delta=>deltas.push(delta)),/fixture retry unavailable/);
 assert.deepEqual(deltas,['Incomplete fixture response']);assert.equal(s.errorCount,1);
});
