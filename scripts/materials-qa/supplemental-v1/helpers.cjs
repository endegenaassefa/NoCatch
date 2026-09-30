'use strict';
const fs=require('node:fs'),path=require('node:path');
const PROJECT=process.env.MATERIALS_PROJECT||'/mnt/c/users/endeg/Desktop/NoCatch-session-materials';
const {MaterialsManager}=require(path.join(PROJECT,'src/materials'));
const FIX=path.resolve(__dirname,'../fixtures'),ROOT=path.join(__dirname,'results');fs.mkdirSync(ROOT,{recursive:true});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick=()=>new Promise(r=>setImmediate(r));
async function fixture(t,{active=true,onInvalidate=()=>{}}={}){let clock=Date.now();const dir=fs.mkdtempSync(path.join(ROOT,'case-'));const m=new MaterialsManager({userDataPath:dir,safeStorage:{isEncryptionAvailable:()=>false},owner:'qa-alice',now:()=>clock,onInvalidate});t.after(async()=>{await m.close();fs.rmSync(dir,{recursive:true,force:true})});await m.importFiles([path.join(FIX,'relationship-order-notes-visual.pptx')]);if(active)await m.start({consent:true});return {m,dir,expire:()=>{clock=m.status().expiresAt},now:()=>clock};}
async function invalidate(f,action){if(action==='expire'){f.expire();f.m.status()}else if(action==='owner')await f.m.setOwner('qa-bob');else if(action==='remove')await f.m.remove(f.m.status().documents.find(d=>!d.error).id);else await f.m.end('qa')}
function noPlaintext(dir,needle){for(const x of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,x.name);if(x.isDirectory())noPlaintext(p,needle);else if(fs.readFileSync(p).includes(Buffer.from(needle)))throw Error(`Plaintext ${needle} persisted in ${p}`)}}
module.exports={PROJECT,FIX,ROOT,fixture,deferred,tick,invalidate,noPlaintext};
