'use strict';
const path=require('node:path'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const root=__dirname,args=process.argv.slice(2),kind=args[0]||'test',get=(k,f)=>{const i=args.indexOf(k);return i<0?f:args[i+1]};
const project=process.env.MATERIALS_PROJECT||path.resolve(root,'../../..');const env={...process.env,MATERIALS_PROJECT:get('--project',project),MATERIALS_QA_PHASE:get('--phase','first-run')};delete env.ELECTRON_RUN_AS_NODE;
const native=kind!=='test',binary=native?get('--electron'):process.execPath;if(!binary)throw Error('Provide --electron path');
const scripts={cancel:'native-cancel.cjs',main:'full-main-expiry.cjs'};const argv=native?[path.join(root,scripts[kind]||'missing')]:['--test','--test-timeout=10000',path.join(root,'lifecycle.test.cjs'),path.join(root,'generation.test.cjs')];
const r=spawnSync(binary,argv,{env,encoding:'utf8',timeout:60000,maxBuffer:10*1024*1024});const out=path.join(root,'results');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,kind+'.log'),(r.stdout||'')+(r.stderr||''));fs.writeFileSync(path.join(out,kind+'-run.json'),JSON.stringify({binary,argv,project:env.MATERIALS_PROJECT,status:r.status,error:r.error?.message},null,2)+'\n');if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);if(r.error)console.error(r.error.message);process.exitCode=r.status??1;
