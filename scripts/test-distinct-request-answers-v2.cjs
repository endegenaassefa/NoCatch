'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function harness(){
 const html=fs.readFileSync(path.join(__dirname,'../chat.html'),'utf8'),messages=[],callbacks={};
 const slice=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);assert(a>=0&&b>a,`Production region missing: ${start}`);return html.slice(a,b)};
 const context={console,crypto:{randomUUID:()=> 'fixture'},clearTimeout(){},hideThinkingIndicator(){},addMessage:(text,type)=>messages.push({text,type}),addCodeSnippet:(language,code)=>messages.push({language,code}),whysperAPI:{onTranscriptionLlmResponse:fn=>callbacks.final=fn},Map,Set};
 vm.createContext(context);
 const code=slice('let chatGeneration = 0;','function saveHistory()')+'\n'+slice('function finishPendingResponse(request)','function showResponseError(')+'\n'+slice('function extractCodeBlocks(text)','function addCodeSnippet(')+'\n'+slice('function renderAssistantResponse(','// Basic IPC Event Listeners')+'\n'+slice('whysperAPI.onTranscriptionLlmResponse((event, data) => {','if (whysperAPI.onTranscriptionLlmResponseStart)');
 vm.runInContext(code,context);return {messages,start:id=>context.beginRequest(id),final:(id,response)=>callbacks.final({}, {requestId:id,messageId:'message-'+id,response})};
}
test('different requests with identical final content each retain a visible answer',()=>{const h=harness();h.start('request-one');h.final('request-one','24');h.start('request-two');h.final('request-two','24');assert.deepEqual(h.messages,[{text:'24',type:'assistant'},{text:'24',type:'assistant'}]);});
test('duplicate final for the same completed request adds no second answer',()=>{const h=harness();h.start('request-one');h.final('request-one','24');h.final('request-one','24');assert.deepEqual(h.messages,[{text:'24',type:'assistant'}]);});
