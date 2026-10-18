import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('.',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml'};
const miloraEndpoint='https://api.milorapart.top/apis/mbAIsc';
const allowedAudioHosts=new Set(['media.milorapart.top','api.milorapart.top']);
const aliyunHttpModel='qwen3-tts-vc-2026-01-22';

async function proxyMilora(url,res){
  const text=url.searchParams.get('text')?.trim();
  if(!text){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'缺少 text 参数'}));}
  const apiUrl=new URL(miloraEndpoint);apiUrl.searchParams.set('text',text);apiUrl.searchParams.set('format','mp3');
  const apiResponse=await fetch(apiUrl);const result=await apiResponse.json();
  if(!apiResponse.ok||result.code!==200||!result.url)throw new Error(result.msg||'Milora 未返回音频地址');
  const audioUrl=new URL(String(result.url).replace(/^http:\/\//,'https://'));
  if(!allowedAudioHosts.has(audioUrl.hostname))throw new Error('音频地址不是允许的 Milora 域名');
  const audioResponse=await fetch(audioUrl);if(!audioResponse.ok)throw new Error(`音频下载失败（${audioResponse.status}）`);
  const buffer=Buffer.from(await audioResponse.arrayBuffer());
  res.writeHead(200,{'Content-Type':'audio/mpeg','Content-Length':String(buffer.length),'Content-Disposition':`attachment; filename="voiceprint-${Date.now()}.mp3"`,'Cache-Control':'no-store'});res.end(buffer);
}

function aliyunBase(endpoint){
  let u;try{u=new URL(endpoint||'https://dashscope.aliyuncs.com/api/v1')}catch{throw new Error('阿里云 Endpoint 格式无效')}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('阿里云 Endpoint 必须是 HTTPS API Host');
  const host=u.hostname.toLowerCase();
  const publicHost=['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com'].includes(host);
  const workspaceHost=/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/i.test(host);
  if(!publicHost&&!workspaceHost)throw new Error('阿里云 Endpoint 必须是 DashScope 或北京/新加坡 Workspace 专属 API Host');
  if(!['/','/api/v1','/api/v1/'].includes(u.pathname))throw new Error('阿里云 Endpoint 路径请使用根域名或 /api/v1');
  return `${u.origin}/api/v1`;
}

async function fetchAliyun(url,options,stage){try{return await fetch(url,options)}catch(error){throw new Error(`阿里云${stage}网络失败：${error.cause?.code||error.message||'连接失败'}`)}}

async function aliyunHttpTts({apiKey,model,text,audioData,voice,endpoint}){
  if(!apiKey||!text?.trim()||(!audioData&&!voice))throw new Error('缺少 API Key、合成文本或参考音频/Voice ID');
  const modelId=model||aliyunHttpModel;
  if(modelId!==aliyunHttpModel)throw new Error(`当前直连接口固定使用 HTTP 模型 ${aliyunHttpModel}`);
  const base=aliyunBase(endpoint);
  const headers={Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'};
  let voiceId=voice||'';
  if(audioData){
    if(!/^data:audio\/(wav|mpeg|mp4);base64,[a-z0-9+/=]+$/i.test(audioData))throw new Error('参考音频数据格式无效，请重新选择 WAV、MP3 或 M4A');
    const probe=await fetchAliyun(`${base}/services/aigc/multimodal-generation/generation`,{method:'POST',headers,body:JSON.stringify({model:modelId,input:{text:'测试',voice:'voiceprint_preflight_unknown',language_type:'Chinese'}})},'模型预检');
    const probeData=await probe.json().catch(()=>({}));
    const probeMessage=String(probeData.message||probeData.msg||'');
    if(/model\s+not\s+(exist|found)/i.test(probeMessage))throw new Error(`百炼当前 Workspace 无法调用 ${modelId}（Model not exist）；请先在北京地域对应业务空间开通该模型。未创建参考音色。`);
    if([401,403,429].includes(probe.status)||probe.status>=500)throw new Error(`阿里云 HTTP 模型预检失败（${probe.status}${probeData.code?` ${probeData.code}`:''}）：${probeMessage||'请检查 API Key、Endpoint 和模型权限'}`);
    const cloneResponse=await fetchAliyun(`${base}/services/audio/tts/customization`,{method:'POST',headers,body:JSON.stringify({model:'qwen-voice-enrollment',input:{action:'create',target_model:modelId,preferred_name:`vp${Date.now().toString(36).slice(-10)}`,audio:{data:audioData},language:'zh'}})},'创建音色');
    const cloneData=await cloneResponse.json().catch(()=>({}));
    if(!cloneResponse.ok||cloneData.code)throw new Error(`阿里云创建音色失败（${cloneResponse.status}）：${cloneData.message||cloneData.msg||cloneData.code||'请检查模型权限及参考音频'}`);
    voiceId=cloneData.output?.voice||'';
    if(!voiceId)throw new Error('阿里云创建音色成功响应中缺少 voice ID');
  }

  try{
    const synthesisResponse=await fetchAliyun(`${base}/services/aigc/multimodal-generation/generation`,{method:'POST',headers,body:JSON.stringify({model:modelId,input:{text:text.trim(),voice:voiceId,language_type:'Chinese'}})},'HTTP 合成');
    const synthesisData=await synthesisResponse.json().catch(()=>({}));
    if(!synthesisResponse.ok||synthesisData.code)throw new Error(`阿里云 HTTP 合成失败（${synthesisResponse.status}${synthesisData.code?` ${synthesisData.code}`:''}）：${synthesisData.message||synthesisData.msg||'请在百炼模型广场开通 '+modelId}`);
    const resultUrl=synthesisData.output?.audio?.url;
    if(!resultUrl)throw new Error('阿里云合成响应中缺少音频 URL');
    let audioUrl;try{audioUrl=new URL(String(resultUrl))}catch{throw new Error('阿里云返回的音频 URL 格式无效')}
    if(!['https:','http:'].includes(audioUrl.protocol)||!audioUrl.hostname.toLowerCase().endsWith('.aliyuncs.com'))throw new Error('阿里云返回了不受支持的音频下载地址');
    let audioResponse;
    if(audioUrl.protocol==='http:'){
      const secureUrl=new URL(audioUrl.href);secureUrl.protocol='https:';
      try{audioResponse=await fetchAliyun(secureUrl,{},'合成音频下载')}catch{audioResponse=await fetchAliyun(audioUrl,{},'合成音频下载')}
      if(!audioResponse.ok&&audioResponse.status>=400)audioResponse=await fetchAliyun(audioUrl,{},'合成音频下载');
    }else audioResponse=await fetchAliyun(audioUrl,{},'合成音频下载');
    if(!audioResponse.ok)throw new Error(`阿里云合成音频下载失败（HTTP ${audioResponse.status}）`);
    const buffer=Buffer.from(await audioResponse.arrayBuffer());
    if(!buffer.length||buffer.length>30*1024*1024)throw new Error('阿里云返回的音频为空或超过 30 MB');
    return {buffer,voice:voiceId};
  }catch(error){
    if(audioData)await fetch(`${base}/services/audio/tts/customization`,{method:'POST',headers,body:JSON.stringify({model:'qwen-voice-enrollment',input:{action:'delete',voice:voiceId}})}).catch(()=>{});
    throw error;
  }
}

async function readJson(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>20*1024*1024)throw new Error('请求体过大')}return JSON.parse(body||'{}')}
const server=http.createServer(async(req,res)=>{try{
  const pathname=decodeURIComponent((req.url||'/').split('?')[0]);const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(pathname==='/api/milora')return await proxyMilora(url,res);
  if(pathname==='/api/aliyun/tts-http'&&req.method==='POST'){
    const input=await readJson(req);const result=await aliyunHttpTts(input);
    res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':String(result.buffer.length),'X-Voice-Id':result.voice,'Cache-Control':'no-store'});
    return res.end(result.buffer);
  }
  const safe=normalize(pathname==='/'?'/index.html':pathname);const file=join(root,safe);
  if(!file.startsWith(root)){res.writeHead(403);return res.end('Forbidden')}
  const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);
}catch(error){
  if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:error.message||'代理请求失败'}))}else res.destroy();
}});
server.listen(Number(process.env.PORT||4173),'0.0.0.0',()=>console.log('PWA server ready'));
