const PROVIDERS={
  'milora-mambo':{name:'Milora 曼波免费版',endpoint:'https://api.milorapart.top/apis/mbAIsc',model:'曼波免费试用版'},
  'fish-audio':{name:'Fish Audio',endpoint:'https://api.fish.audio/v1/tts',model:'s2.1-pro-free'},
  'aliyun-qwen-tts':{name:'阿里云 Qwen Audio 3.1',endpoint:'https://dashscope.aliyuncs.com/api/v1',model:'qwen-audio-3.1-tts-flash'},
  custom:{name:'自定义接口',endpoint:'',model:''}
};
const ALIYUN_MODELS=[{id:'qwen-audio-3.1-tts-flash',label:'Qwen Audio 3.1 声音复刻（HTTP）'}];
const STORAGE='voiceprint-pwa-settings-v1',HISTORY='voiceprint-pwa-history-v1';
const $=id=>document.getElementById(id);
const state={settings:loadSettings(),reference:null,referenceUrl:null,recorder:null,chunks:[],generatedBlob:null,generatedUrl:null,generating:false};
function loadSettings(){const base={activeProvider:'milora-mambo',profiles:{}};try{const saved=JSON.parse(localStorage.getItem(STORAGE)||'{}');base.activeProvider=saved.activeProvider||base.activeProvider;base.profiles=saved.profiles||{};const aliyun=base.profiles['aliyun-qwen-tts'];if(aliyun&&aliyun.model!=='qwen-audio-3.1-tts-flash'){aliyun.model='qwen-audio-3.1-tts-flash';aliyun.voiceId='';aliyun.voiceReferenceHash='';aliyun.voiceEndpoint=''}return base}catch{return base}}
function profile(key=state.settings.activeProvider){return {...PROVIDERS[key],...(state.settings.profiles[key]||{}),provider:key}}
function saveSettings(){localStorage.setItem(STORAGE,JSON.stringify(state.settings))}
function toast(message,type=''){const node=document.createElement('div');node.className='toast '+type;node.textContent=message;$('toastRegion').appendChild(node);setTimeout(()=>node.remove(),3600)}
function setStatus(text){$('activeStatus').textContent='当前接口：'+text}
function activeName(){return PROVIDERS[state.settings.activeProvider]?.name||state.settings.activeProvider}
function updateStatus(){setStatus(activeName())}
function updateReference(file,source){if(state.referenceUrl)URL.revokeObjectURL(state.referenceUrl);state.reference=file;state.referenceUrl=URL.createObjectURL(file);$('referenceCard').classList.remove('empty');$('referenceName').textContent=file.name;$('referenceMeta').textContent=source+' · '+formatBytes(file.size);$('referenceBadge').textContent='已准备'}
function formatBytes(n){return n<1024?`${n} B`:`${(n/1024/1024).toFixed(1)} MB`}
function audioExt(){return state.reference?.name?.split('.').pop()?.toLowerCase()||'m4a'}
function notifyDone(){
  if(navigator.vibrate)navigator.vibrate([40,30,40]);
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  const show=registration=>registration?.showNotification?.('声纹工坊：生成完成',{body:'音频已经准备好，可以试听或下载。'});
  if(state.serviceWorkerRegistration)state.serviceWorkerRegistration.then(show).catch(()=>{});
  else if('serviceWorker' in navigator)navigator.serviceWorker.ready.then(show).catch(()=>{});
}
function renderHistory(){const items=JSON.parse(localStorage.getItem(HISTORY)||'[]');const el=$('historyList');if(!items.length){el.innerHTML='<div class="empty-state">还没有生成记录</div>';return}el.innerHTML=items.slice(0,12).map((h,i)=>`<div class="history-item"><div><strong>${escapeHtml(h.text)}</strong><small>${h.provider} · ${h.time} · ${h.speed}× · ${h.emotion}</small></div><button class="history-play" data-index="${i}">载入</button></div>`).join('');el.querySelectorAll('.history-play').forEach(btn=>btn.onclick=()=>{const h=items[Number(btn.dataset.index)];if(h.url){$('audioPlayer').src=h.url;$('resultTitle').textContent='历史音频';$('resultMeta').textContent=h.time;$('resultCard').classList.remove('hidden');state.generatedUrl=h.url;toast('已载入历史音频','success')}else toast('历史文件只保留在生成当次浏览器会话中，请重新生成','error')})}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function saveHistory(text,provider,speed,emotion,url){const items=JSON.parse(localStorage.getItem(HISTORY)||'[]');items.unshift({text,provider:PROVIDERS[provider]?.name||provider,speed,emotion,time:new Date().toLocaleString(),url});localStorage.setItem(HISTORY,JSON.stringify(items.slice(0,30)));renderHistory()}
async function blobFromUrl(url){const response=await fetch(String(url).replace(/^http:\/\//,'https://'));if(!response.ok)throw new Error(`音频下载失败（${response.status}）`);return await response.blob()}
async function generateMilora(text,p){const url=new URL('/api/milora',window.location.origin);url.searchParams.set('text',text);const r=await fetch(url);if(!r.ok){let message='Milora 代理请求失败';try{message=(await r.json()).error||message}catch{}throw new Error(message)}return r.blob();}
async function generateFish(text,p){if(!p.apiKey)throw new Error('Fish Audio 需要 API Key');if(!p.voiceId)throw new Error('Fish Audio 需要 Voice ID / reference_id');const r=await fetch(p.endpoint||PROVIDERS['fish-audio'].endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${p.apiKey}`,model:p.model||'s2.1-pro-free'},body:JSON.stringify({text,reference_id:p.voiceId,prosody:{speed:Number($('speedInput').value),volume:0,normalize_loudness:true},format:'mp3',normalize:true})});const type=r.headers.get('content-type')||'';if(!r.ok)throw new Error(type.includes('json')?((await r.json()).message||'Fish Audio 请求失败'):`Fish Audio 请求失败（${r.status}）`);return r.blob()}
function fileToDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)})}
async function fileToAliyunWav(file){
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass)throw new Error('当前浏览器不支持音频格式转换，请上传 WAV、MP3 或 M4A 文件');
  const context=new AudioContextClass();
  try{
    const source=await context.decodeAudioData(await file.arrayBuffer());
    const length=Math.ceil(source.duration*24000);
    const offline=new OfflineAudioContext(1,length,24000);
    const buffer=offline.createBuffer(1,source.length,source.sampleRate);
    const channel=buffer.getChannelData(0);
    for(let c=0;c<source.numberOfChannels;c++){
      const input=source.getChannelData(c);
      for(let i=0;i<input.length;i++)channel[i]+=input[i]/source.numberOfChannels;
    }
    const node=offline.createBufferSource();node.buffer=buffer;node.connect(offline.destination);node.start();
    const rendered=await offline.startRendering();
    const samples=rendered.getChannelData(0), wav=new ArrayBuffer(44+samples.length*2), view=new DataView(wav);
    const write=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i))};
    write(0,'RIFF');view.setUint32(4,36+samples.length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++){const sample=Math.max(-1,Math.min(1,samples[i]));view.setInt16(44+i*2,sample<0?sample*32768:sample*32767,true)}
    return fileToDataUrl(new File([wav],`reference-${Date.now()}.wav`,{type:'audio/wav'}));
  }finally{await context.close().catch(()=>{})}
}
async function fingerprintAudio(file){const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')}
async function generateAliyun(text,p){
  if(!p.apiKey)throw new Error('阿里云需要 API Key');
  const root=p.endpoint||PROVIDERS['aliyun-qwen-tts'].endpoint,model='qwen-audio-3.1-tts-flash';let audioData='',referenceHash='';
  if(state.reference){const mime=(state.reference.type||'').toLowerCase(),name=(state.reference.name||'').toLowerCase();const supported=mime.startsWith('audio/')||/\.(mp3|m4a|wav|webm|ogg)$/.test(name);if(!supported)throw new Error('参考音频必须是 WAV、MP3 或 M4A');referenceHash=await fingerprintAudio(state.reference);const canReuseVoice=p.voiceId&&p.voiceReferenceHash===referenceHash&&p.voiceEndpoint===root;if(!canReuseVoice)audioData=await fileToAliyunWav(state.reference)}
  if(!audioData&&!p.voiceId)throw new Error('请先选择参考音频，或填写已创建的 Qwen-TTS Voice ID');
  const emotion=$('emotionInput').value,instruction=emotion==='自然'?'':`请用${emotion}的情感和语气朗读。`;
  const response=await fetch('/api/aliyun/tts-http',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:p.apiKey,model,voice:audioData?'':p.voiceId,audioData,text,endpoint:root,rate:Number($('speedInput').value),instruction})});
  if(!response.ok){let message='阿里云 HTTP 语音合成失败';try{message=(await response.json()).error||message}catch{}throw new Error(message)}
  const createdVoice=response.headers.get('X-Voice-Id');if(createdVoice){const key='aliyun-qwen-tts';state.settings.profiles[key]={...profile(key),voiceId:createdVoice,...(audioData?{voiceReferenceHash:referenceHash,voiceEndpoint:root}:{})};saveSettings();$('voiceInput').value=createdVoice}
  return response.blob();
}
async function generateCustom(text,p){if(!p.endpoint)throw new Error('请先填写自定义 Endpoint');const r=await fetch(p.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(p.apiKey?{Authorization:`Bearer ${p.apiKey}`}:{})},body:JSON.stringify({text,model:p.model,voice_id:p.voiceId,reference_id:p.voiceId,speed:Number($('speedInput').value),emotion:$('emotionInput').value})});if(!r.ok)throw new Error(`自定义接口请求失败（${r.status}）`);const type=r.headers.get('content-type')||'';if(type.includes('json')){const data=await r.json();const url=data.audio_url||data.url||data.output?.audio?.url;if(!url)throw new Error('自定义接口未返回 audio_url/url');return blobFromUrl(url)}return r.blob()}
async function generate(){if(state.generating)return;const text=$('textInput').value.trim();if(!text){toast('请输入要合成的文案','error');return}const p=profile();if(p.provider!=='milora-mambo'&&!state.reference&&!p.voiceId){toast('请先选择或录制参考音频','error');return}state.generating=true;const button=$('generateButton');button.disabled=true;button.innerHTML='<span>正在生成，请稍候…</span><span class="spinner">◌</span>';$('resultCard').classList.add('hidden');try{let result;if(p.provider==='milora-mambo')result={blob:await generateMilora(text,p)};else if(p.provider==='fish-audio')result={blob:await generateFish(text,p)};else if(p.provider==='aliyun-qwen-tts')result={blob:await generateAliyun(text,p)};else result={blob:await generateCustom(text,p)};if(state.generatedUrl&&!state.generatedRemoteUrl)URL.revokeObjectURL(state.generatedUrl);state.generatedBlob=result.blob||null;state.generatedRemoteUrl=result.remoteUrl||null;state.generatedUrl=result.remoteUrl||URL.createObjectURL(result.blob);$('audioPlayer').src=state.generatedUrl;$('resultTitle').textContent='生成完成';$('resultMeta').textContent=result.remoteUrl?`${activeName()} · 在线音频已准备好`:`${activeName()} · ${formatBytes(result.blob.size)}`;$('resultCard').classList.remove('hidden');saveHistory(text,p.provider,Number($('speedInput').value).toFixed(2),$('emotionInput').value,state.generatedUrl);toast('生成完成，可以试听或下载','success');notifyDone()}catch(error){$('resultTitle').textContent='生成失败';$('resultMeta').textContent=error.message||String(error);toast(error.message||'生成失败','error')}finally{state.generating=false;button.disabled=false;button.innerHTML='<span>生成试听</span><span>→</span>'}}
function renderSettings(){
  const p=profile(),select=$('modelInput'),isAliyun=state.settings.activeProvider==='aliyun-qwen-tts';
  $('endpointInput').value=p.endpoint||'';$('apiKeyInput').value=p.apiKey||'';
  const choices=isAliyun?ALIYUN_MODELS:[{id:p.model||'',label:p.model||'默认模型'}];
  select.innerHTML=choices.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} — ${escapeHtml(item.id)}</option>`).join('')+(isAliyun?'':'<option value="__custom__">自定义模型 ID…</option>');
  const known=choices.some(item=>item.id===p.model);select.value=known?p.model:(isAliyun?choices[0].id:'__custom__');
  $('customModelInput').value=known?'':(p.model||'');$('customModelRow').classList.toggle('hidden',isAliyun||select.value!=='__custom__');
  $('voiceInput').value=p.voiceId||'';$('outputInput').value=p.outputDir||'';
  document.querySelectorAll('.provider-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.provider===state.settings.activeProvider));
}
function openSettings(){renderSettings();$('settingsBackdrop').classList.remove('hidden');document.body.classList.add('modal-open')}
function closeSettings(){document.activeElement?.blur();$('settingsBackdrop').classList.add('hidden');document.body.classList.remove('modal-open')}
function saveSettingsFromForm(){
  const key=state.settings.activeProvider,isAliyun=key==='aliyun-qwen-tts';
  const model=isAliyun?$('modelInput').value:($('modelInput').value==='__custom__'?$('customModelInput').value.trim():$('modelInput').value);
  state.settings.profiles[key]={...profile(key),endpoint:$('endpointInput').value.trim(),apiKey:$('apiKeyInput').value,model,voiceId:$('voiceInput').value.trim(),outputDir:$('outputInput').value.trim()};
  saveSettings();updateStatus();toast(`${PROVIDERS[key].name} 配置已保存`,'success');$('settingsSave').textContent='已保存 ✓';setTimeout(()=>$('settingsSave').textContent='保存当前配置',1400)
}
function bind(){
  $('settingsOpen').onclick=openSettings;$('settingsOpen2').onclick=openSettings;$('settingsClose').onclick=closeSettings;$('settingsCancel').onclick=closeSettings;$('settingsBackdrop').onclick=e=>{if(e.target===$('settingsBackdrop'))closeSettings()};$('settingsSave').onclick=saveSettingsFromForm;$('modelInput').onchange=()=> $('customModelRow').classList.toggle('hidden',state.settings.activeProvider==='aliyun-qwen-tts'||$('modelInput').value!=='__custom__');
  $('providerTabs').innerHTML=Object.entries(PROVIDERS).map(([key,p])=>`<button class="provider-tab" data-provider="${key}">${p.name}</button>`).join('');document.querySelectorAll('.provider-tab').forEach(btn=>btn.onclick=()=>{state.settings.activeProvider=btn.dataset.provider;renderSettings()});
  $('fileButton').onclick=()=>$('fileInput').click();$('fileInput').onchange=e=>{const file=e.target.files?.[0];if(file)updateReference(file,'本地文件');e.target.value=''};
  $('recordButton').onclick=async()=>{if(state.recorder&&state.recorder.state==='recording'){state.recorder.stop();$('recordLabel').textContent='正在保存录音…';return}try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});const mime=MediaRecorder.isTypeSupported('audio/mp4')?'audio/mp4':MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'audio/ogg';state.chunks=[];state.recorder=new MediaRecorder(stream,{mimeType:mime});state.recorder.ondataavailable=e=>{if(e.data.size)state.chunks.push(e.data)};state.recorder.onstop=()=>{stream.getTracks().forEach(track=>track.stop());const ext=mime.includes('mp4')?'m4a':mime.includes('webm')?'webm':'ogg';updateReference(new File(state.chunks,`reference-${Date.now()}.${ext}`,{type:mime}),'刚刚录音');$('recordLabel').textContent='开始录音'};state.recorder.start();$('recordLabel').textContent='停止录音';toast('正在录音，再次点击停止','success')}catch(error){toast('无法录音：请允许浏览器访问麦克风','error')}};
  $('speedInput').oninput=e=>$('speedValue').textContent=Number(e.target.value).toFixed(2)+'×';$('generateButton').onclick=generate;$('downloadButton').onclick=()=>{if(!state.generatedUrl)return;if(state.generatedRemoteUrl){window.open(state.generatedRemoteUrl,'_blank','noopener');toast('已打开音频地址，请用 Safari 分享菜单存储到“文件”','success');return}const a=document.createElement('a');a.href=state.generatedUrl;const ext=state.generatedBlob?.type?.includes('wav')?'wav':'mp3';a.download=`voiceprint-${Date.now()}.${ext}`;a.click();toast('已开始下载','success')};$('shareButton').onclick=async()=>{if(state.generatedRemoteUrl){window.open(state.generatedRemoteUrl,'_blank','noopener');toast('已打开音频地址，请使用 Safari 分享菜单保存或分享','success');return}if(!state.generatedBlob)return;const ext=state.generatedBlob.type?.includes('wav')?'wav':'mp3';const file=new File([state.generatedBlob],`voiceprint-${Date.now()}.${ext}`,{type:state.generatedBlob.type||'audio/mpeg'});if(navigator.share&&navigator.canShare?.({files:[file]})){try{await navigator.share({title:'声纹工坊音频',files:[file]})}catch(error){if(error.name!=='AbortError')toast('分享失败','error')} }else{$('downloadButton').click();toast('当前浏览器不支持系统分享，已改为下载','success')}};
}
updateStatus();renderHistory();bind();
if('serviceWorker'in navigator)state.serviceWorkerRegistration=navigator.serviceWorker.register('/sw.js').catch(()=>null);
if('Notification'in window&&Notification.permission==='default')Notification.requestPermission().catch(()=>{});
