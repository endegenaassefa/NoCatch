'use strict';
const { formatMaterialContext } = require('../materials/context');
const cancelled=()=>Object.assign(new Error('The material session changed or expired. Please ask again.'),{code:'CANCELLED'});
function boundedHistory(history,textLength){
  let remaining=Math.min(6000,Math.max(0,30000-textLength));const result=[];
  for(const item of (Array.isArray(history)?history:[]).slice(-20).reverse()){
    if(!['user','assistant','model'].includes(item?.role)||typeof item.content!=='string')continue;
    const content=item.content.slice(-remaining);if(!remaining)break;
    result.unshift({role:item.role==='model'?'assistant':item.role,content});remaining-=content.length;
  }return result;
}
function attachMaterialsSession(service,{materials,managedSession,getAIMode=()=> 'managed',answerDirect}){
  const run=async (text,image,skill,history,language,onDelta)=>{
    const started=Date.now(),snapshot=materials.snapshot(),status=materials.status();
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(90000,status.expiresAt-Date.now())));
    timer.unref?.();
    const check=()=>{if(controller.signal.aborted||!materials.isCurrent(snapshot)){controller.abort();throw cancelled();}};
    const poll=setInterval(()=>{if(!materials.isCurrent(snapshot))controller.abort();},50);poll.unref?.();
    const dispatch=async(payload,delta)=>{
      check();const options={signal:controller.signal,onDelta:value=>{check();delta?.(value);}};
      let abort;
      try {
        const pending=getAIMode()==='direct'?answerDirect(payload,options):managedSession.answerScoped(payload,options);
        const result=await Promise.race([pending,new Promise((_,reject)=>{abort=()=>reject(cancelled());controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();})]);
        check();return result;
      }finally{controller.signal.removeEventListener('abort',abort);}
    };
    try{
      check();if(typeof text!=='string'||text.length>16000)throw new Error('Use a question of at most 16,000 characters.');
      const provider=process.env.LLM_PROVIDER==='deepseek'?'deepseek':'gemini';
      const messages=boundedHistory(history,text.length);
      if(image){
        if(provider!=='gemini')throw new Error('Choose Gemini for screenshot questions.');
        const marker={sessionId:status.id,generation:status.generation,expiresAt:status.expiresAt,sources:[]};
        const query=await dispatch({text:'Read this screenshot. Return only the question text and key concepts needed to find relevant reference slides. Do not answer the question.',image,provider,skill:'general',history:[],materialContext:marker},null);
        text=String(query.text||'').slice(0,8000);check();
      }
      const budget=Math.min(24000,32000-text.length-messages.reduce((n,t)=>n+t.content.length,0)-2048);
      const materialContext=materials.retrieve(text,{maxChars:budget});
      check();if(!materialContext)throw cancelled();
      formatMaterialContext(materialContext,{maxChars:budget});
      const result=await dispatch({text,...(image?{image}:{}),skill:skill||'general',history:messages,language:language||undefined,provider,materialContext},onDelta);
      return {response:result.text,metadata:{skill,programmingLanguage:language,processingTime:Date.now()-started,usedFallback:false,requestId:result.requestId,
        managed:getAIMode()!=='direct',materialSession:{sessionId:status.id,generation:status.generation,expiresAt:status.expiresAt},sources:materialContext.sources.map(({text,...source})=>source)}};
    }finally{clearTimeout(timer);clearInterval(poll);controller.abort();}
  };
  for(const name of ['processTextWithSkill','processTextWithSkillStream','processTranscriptionWithIntelligentResponse','processTranscriptionWithIntelligentResponseStream']){
    const original=service[name].bind(service);service[name]=(...args)=>materials.status().state==='active'?run(args[0],null,args[1],args[2],args[3],args[4]):original(...args);
  }
  for(const name of ['processImageWithSkill','processImageWithSkillStream']){
    const original=service[name].bind(service);service[name]=(...args)=>{
      if(materials.status().state!=='active')return original(...args);
      if(!Buffer.isBuffer(args[0])||!args[0].length||args[0].length>2*1024*1024)return Promise.reject(new Error('Choose a screenshot smaller than 2 MiB.'));
      return run('Answer the question in this screenshot.',{data:args[0].toString('base64'),mimeType:args[1]},args[2],args[3],args[4],args[5]);
    };
  }return service;
}
module.exports={attachMaterialsSession};
