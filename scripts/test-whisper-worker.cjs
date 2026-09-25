const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const root=path.resolve(__dirname, '..');
test('old Whisper process close and output cannot invalidate its replacement',async()=>{
 const children=[];const quiet=new Proxy({},{get:()=>()=>{}});
 const sandbox={module:{exports:{}},console,setTimeout,clearTimeout,require:n=>n==='fs'?{existsSync:()=>true}:n==='child_process'?{spawn:()=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin={write:(_s,cb)=>cb()};c.kill=()=>{c.killed=true};children.push(c);return c;}}:n==='readline'?{createInterface:({input})=>input}:n==='../core/logger'?{createServiceLogger:()=>quiet}:require(n)};
 vm.runInNewContext(fs.readFileSync(path.join(root,'src/services/whisper-worker.service.js'),'utf8'),sandbox);
 const w=new sandbox.module.exports();w.configure({pythonPath:'fixture',scriptPath:'fixture'});
 const old=w._request({action:'warmup'}).catch(()=>{});const a=children[0];w.close();await old;
 assert.throws(()=>w._request({action:'warmup'}),e=>e.code==='WHISPER_WORKER_TERMINATION_UNCONFIRMED');
 a.emit('close',0);
 let rejected=false;const pending=w._request({action:'warmup'}).catch(e=>{rejected=true;throw e});pending.catch(()=>{});const b=children[1];
 a.emit('close',0);a.stdout.emit('line',JSON.stringify({id:2,ok:true,text:'stale'}));await new Promise(r=>setImmediate(r));
 try {assert.equal(w.process,b);assert.equal(rejected,false);assert.equal(w.pending.size,1);b.stdout.emit('line',JSON.stringify({id:2,ok:true,text:'current'}));assert.equal((await pending).text,'current');
 const failed=w._request({action:'warmup'}); const failure=assert.rejects(failed,/fixture failure/);
 b.emit('error',new Error('fixture failure'));
 assert.throws(()=>w._request({action:'warmup'}),e=>e.code==='WHISPER_WORKER_TERMINATION_UNCONFIRMED');
 b.emit('close',1); await failure; assert.equal(w.process,null);
 const recovered=w._request({action:'warmup'}); const c=children[2];
 b.emit('close',1); assert.equal(w.process,c);
 c.stdout.emit('line',JSON.stringify({id:4,ok:true,text:'recovered'})); assert.equal((await recovered).text,'recovered');}finally{w.close();for(const child of children)child.emit('close',0);}
});
