'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2),get=(k,f)=>{const i=args.indexOf(k);return i<0?f:args[i+1]};
const electron=get('--electron');if(!electron)throw Error('Provide --electron standalone Electron binary.');
const env={...process.env,MATERIALS_PROJECT:path.resolve(get('--project',path.resolve(__dirname,'../../..'))),MATERIALS_QA_PHASE:get('--phase','first-run')};delete env.ELECTRON_RUN_AS_NODE;
const r=spawnSync(path.resolve(electron),[path.join(__dirname,'full-main.cjs')],{env,stdio:'inherit'});if(r.error)throw r.error;process.exitCode=r.status??1;
