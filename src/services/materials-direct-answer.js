'use strict';
const crypto=require('node:crypto');
const config=require('../core/config');
const {createProvider}=require('../../server/providers');
function createMaterialsDirectAnswer({llmService}){
  return async(payload,{signal,onDelta=()=>{},onUsage=()=>{}}={})=>{
    if(!llmService.isInitialized||llmService.provider!==payload.provider)throw new Error('Configure the selected provider in Settings first.');
    const abortSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000);
    const settings={geminiKey:config.getApiKey('GEMINI'),deepseekKey:llmService.deepseekClient?.apiKey,
      qwenKey:llmService.qwenClient?.apiKey,qwenModel:llmService.qwenClient?.model,qwenBaseUrl:llmService.qwenClient?.baseUrl,geminiModel:llmService.model,deepseekModel:llmService.deepseekClient?.model||llmService.model,limits:{outputTokens:4096}};
    const provider=createProvider(settings,payload.provider==='deepseek'?{deepseek:`${llmService.deepseekClient.baseUrl.replace(/\/$/,'')}/chat/completions`}:{});
    let text='';
    try{
      await provider({...payload,history:payload.history||[],skill:payload.skill||'general'},{signal:abortSignal,onUsage,onDelta:delta=>{
        abortSignal.throwIfAborted();if(text.length+delta.length>32768)throw new Error('Answer exceeds the output limit.');text+=delta;onDelta(delta);
      }});
      abortSignal.throwIfAborted();if(payload.materialContext && Date.now()>=payload.materialContext.expiresAt)throw new Error('Material session expired');if(!text.trim())throw new Error('Empty answer');
      return {text,requestId:`direct-${crypto.randomUUID()}`};
    }catch{throw Object.assign(new Error(abortSignal.aborted?'The request was cancelled.':'The provider could not complete this request. You can explicitly try again.'),{code:abortSignal.aborted?'CANCELLED':'DIRECT_REQUEST_FAILED'});}
  };
}
module.exports={createMaterialsDirectAnswer};
