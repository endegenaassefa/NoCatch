'use strict';
(()=>{
 const api=window.electronAPI;if(!api)return;
 const host=document.createElement('section');host.hidden=true;host.style.cssText='padding:8px 16px;color:#d0d8e8;background:#151923;font:12px/1.5 system-ui;display:flex;gap:6px;flex-wrap:wrap';
 const anchor=document.getElementById('chatMessages')||document.getElementById('answerText')||document.getElementById('response-content');if(anchor)anchor.before(host);else document.body.append(host);
 const dialog=document.createElement('dialog');dialog.style.cssText='background:#151923;color:#f5f7fb;border:1px solid #3a4354;border-radius:12px;max-width:90vw;max-height:85vh;width:540px;padding:20px';
 const heading=document.createElement('h2'),text=document.createElement('pre'),images=document.createElement('div'),close=document.createElement('button');heading.style.cssText='font:600 15px system-ui';text.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 system-ui;max-height:55vh;overflow:auto';close.textContent='Close source preview';close.onclick=()=>{dialog.close();text.textContent='';};dialog.append(heading,images,text,close);document.body.append(dialog);let epoch=0, scope=null, resolved=false, statusEvents=0, expiryTimer=null;
 dialog.addEventListener('close',()=>{epoch++;text.textContent='';images.replaceChildren();});
 function status(next){statusEvents++;resolved=true;scope=next?.state==='active'?{sessionId:next.id,generation:next.generation,expiresAt:next.expiresAt}:null;}
 api.onMaterialsStatus?.(status);const initialEvents=statusEvents;api.getMaterialsStatus?.().then(r=>{if(statusEvents===initialEvents)status(r.status||r);}).catch(()=>{resolved=true;scope=null;});
 function render(data){
  const marker=data?.materialSession||data?.metadata?.materialSession,sources=data?.sources||data?.metadata?.sources||[];
  const materialStatus=data?.materialStatus||data?.metadata?.materialStatus;
  const defaults={failed:'General knowledge — materials are unavailable.','no-match':'General knowledge — no matching evidence found in the prepared material.',partial:'Using available material; some pages or visual content may be missing.'};
  const notice=data?.materialNotice||data?.metadata?.materialNotice||defaults[materialStatus]||'';
  if((sources.length||notice)&&(!marker||Date.now()>=marker.expiresAt||(resolved&&(!scope||scope.sessionId!==marker.sessionId||scope.generation!==marker.generation))))return;
  clearTimeout(expiryTimer);if(marker)expiryTimer=setTimeout(()=>{epoch++;host.hidden=true;host.replaceChildren();dialog.close();text.textContent='';},Math.max(1,marker.expiresAt-Date.now()));
  host.replaceChildren();host.hidden=!sources.length&&!notice;
  if(notice){const status=document.createElement('span');status.setAttribute('role','status');status.textContent=notice;host.append(status);}
  if(!sources.length)return;const label=document.createElement('span');label.textContent='Cited sources:';host.append(label);
  for(const source of sources){const button=document.createElement('button');button.textContent=`${source.name} · ${source.kind} ${source.page}`;button.style.cssText='background:#202633;color:#a6b8ff;border:1px solid #3a4354;border-radius:5px;padding:4px 8px;font:inherit;cursor:pointer';button.onclick=async()=>{const generation=++epoch;try{const r=await api.previewMaterial(source.documentId,source.page);if(generation!==epoch)return;heading.textContent=button.textContent;text.textContent=r.success===false?r.error.message:[r.preview.text,r.preview.notes].filter(Boolean).join('\n\nSpeaker notes\n');images.replaceChildren();for(const source of r.preview?.images||[]){if(!['image/png','image/jpeg'].includes(source.mimeType)||typeof source.data!=='string')continue;const img=document.createElement('img');img.alt=source.kind==='page-render'?'Original PDF page':'Embedded slide image; full layout unavailable';img.style.cssText='display:block;max-width:100%;height:auto;margin:12px auto';img.src=`data:${source.mimeType};base64,${source.data}`;images.append(img);}if(!dialog.open)dialog.showModal();}catch{if(generation===epoch){heading.textContent='Source unavailable';text.textContent='This source was removed or expired.';if(!dialog.open)dialog.showModal();}}};host.append(button);}
 }
 api.onTranscriptionLlmResponse?.((_event,data)=>render(data));api.onDisplayLlmResponse?.((_event,data)=>render(data));
 api.onMaterialsInvalidated?.(()=>{resolved=true;scope=null;clearTimeout(expiryTimer);epoch++;host.hidden=true;host.replaceChildren();dialog.close();text.textContent='';for(const id of ['full-markdown','markdown-content','code-content','answerText']){const el=document.getElementById(id);if(el)el.textContent='';}});
 window.MaterialSourceLinks={render};
})();
