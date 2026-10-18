import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('.',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml'};
const miloraEndpoint='https://api.milorapart.top/apis/mbAIsc';
const allowedAudioHosts=new Set(['media.milorapart.top','api.milorapart.top']);
const aliyunHttpModel='qwen-audio-3.1-tts-flash';
const temporaryAudio=new Map();

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

function publicOrigin(req){
  const configured=process.env.PUBLIC_APP_URL||process.env.RENDER_EXTERNAL_URL;
  if(configured){let u;try{u=new URL(configured)}catch{throw new Error('PUBLIC_APP_URL 配置无效')};if(u.protocol!=='https:'||u.username||u.password)throw new Error('PUBLIC_APP_URL 必须是 HTTPS 公网地址');return u.origin}
  const host=String(req.headers.host||'').toLowerCase();
  if(!/^[a-z0-9][a-z0-9.-]*\.onrender\.com$/.test(host))throw new Error('参考音频克隆需要通过 HTTPS 公网 Render 地址访问，百炼才能临时读取音频');
  return `https://${host}`;
}

function storeTemporaryAudio(audioData,origin){
  const match=String(audioData||'').match(/^data:(audio\/(?:wav|mpeg|mp4));base64,([a-z0-9+/=]+)$/i);
  if(!match)throw new Error('参考音频数据格式无效，请重新选择 WAV、MP3 或 M4A');
  const buffer=Buffer.from(match[2],'base64');
  if(!buffer.length||buffer.length>15*1024*1024)throw new Error('参考音频为空或超过 15 MB');
  const token=randomBytes(24).toString('hex');
  const expiresAt=Date.now()+5*60*1000;
  temporaryAudio.set(token,{buffer,contentType:match[1].toLowerCase(),expiresAt});
  const timer=setTimeout(()=>temporaryAudio.delete(token),5*60*1000);timer.unref?.();
  return {token,url:`${origin}/api/temporary-audio/${token}`};
}

function serveTemporaryAudio(pathname,req,res){
  const match=pathname.match(/^\/api\/temporary-audio\/([a-f0-9]{48})$/);
  if(!match)return false;
  const item=temporaryAudio.get(match[1]);
  if(!item||item.expiresAt<Date.now()){temporaryAudio.delete(match[1]);res.writeHead(404,{'Cache-Control':'no-store'});res.end('Not Found');return true}
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{'Allow':'GET, HEAD','Cache-Control':'no-store'});res.end();return true}
  res.writeHead(200,{'Content-Type':item.contentType,'Content-Length':String(item.buffer.length),'Cache-Control':'no-store, max-age=0','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD')res.end();else res.end(item.buffer);
  return true;
}

async function fetchAliyun(url,options,stage){try{return await fetch(url,options)}catch(error){throw new Error(`阿里云${stage}网络失败：${error.cause?.code||error.message||'连接失败'}`)}}
async function responseJson(response){return response.json().catch(()=>({}))}
function apiError(stage,response,data){return new Error(`阿里云${stage}失败（HTTP ${response.status}${data.code?` ${data.code}`:''}）：${data.message||data.msg||data.base_resp?.status_msg||'请检查模型权限与请求参数'}`)}

async function aliyunHttpTts({apiKey,model,text,audioData,voice,endpoint,rate,instruction,origin}){
  if(!apiKey||!text?.trim()||(!audioData&&!voice))throw new Error('缺少 API Key、合成文本或参考音频/Voice ID');
  const modelId=aliyunHttpModel;
  const base=aliyunBase(endpoint);
  const headers={Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'};
  let voiceId=voice||'';let tempToken='';let createdVoice=false;
  try{
    if(audioData){
      const temp=storeTemporaryAudio(audioData,origin);tempToken=temp.token;
      const cloneResponse=await fetchAliyun(`${base}/services/audio/tts/customization`,{method:'POST',headers,body:JSON.stringify({model:'voice-enrollment',input:{action:'create_voice',target_model:modelId,prefix:`vp${Date.now().toString(36).slice(-8)}`,url:temp.url,language_hints:['zh']}})},'创建复刻音色');
      const cloneData=await responseJson(cloneResponse);
      if(!cloneResponse.ok||cloneData.code)throw apiError('创建复刻音色',cloneResponse,cloneData);
      voiceId=cloneData.output?.voice_id||'';
      if(!voiceId)throw new Error('阿里云创建音色成功，但响应中缺少 Voice ID');
      createdVoice=true;
    }
  }finally{if(tempToken)temporaryAudio.delete(tempToken)}

  try{
    const input={text:text.trim(),voice:voiceId,format:'wav',sample_rate:24000,rate:Number(rate)||1.0};
    if(instruction)input.instruction=String(instruction).slice(0,200);
    const synthesisResponse=await fetchAliyun(`${base}/services/audio/tts/SpeechSynthesizer`,{method:'POST',headers,body:JSON.stringify({model:modelId,input})},'HTTP 语音合成');
    const synthesisData=await responseJson(synthesisResponse);
    if(!synthesisResponse.ok||synthesisData.code||synthesisData.base_resp?.status_code)throw apiError('HTTP 语音合成',synthesisResponse,synthesisData);
    const resultUrl=synthesisData.output?.audio?.url;
    if(!resultUrl)throw new Error('阿里云合成响应中缺少音频 URL');
    let audioUrl;try{audioUrl=new URL(String(resultUrl))}catch{throw new Error('阿里云返回的音频 URL 格式无效')}
    if(!['https:','http:'].includes(audioUrl.protocol)||!audioUrl.hostname.toLowerCase().endsWith('.aliyuncs.com'))throw new Error('阿里云返回了不受支持的音频下载地址');
    let audioResponse;
    if(audioUrl.protocol==='http:'){
      const secureUrl=new URL(audioUrl.href);secureUrl.protocol='https:';
      try{audioResponse=await fetchAliyun(secureUrl,{},'合成音频下载')}catch{audioResponse=await fetchAliyun(audioUrl,{},'合成音频下载')}
      if(!audioResponse.ok)audioResponse=await fetchAliyun(audioUrl,{},'合成音频下载');
    }else audioResponse=await fetchAliyun(audioUrl,{},'合成音频下载');
    if(!audioResponse.ok)throw new Error(`阿里云合成音频下载失败（HTTP ${audioResponse.status}）`);
    const buffer=Buffer.from(await audioResponse.arrayBuffer());
    if(!buffer.length||buffer.length>30*1024*1024)throw new Error('阿里云返回的音频为空或超过 30 MB');
    return {buffer,voice:createdVoice?voiceId:''};
  }catch(error){
    if(createdVoice&&voiceId)await fetchAliyun(`${base}/services/audio/tts/customization`,{method:'POST',headers,body:JSON.stringify({model:'voice-enrollment',input:{action:'delete_voice',voice_id:voiceId}})},'删除未完成音色').catch(()=>{});
    throw error;
  }
}

async function readJson(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>20*1024*1024)throw new Error('请求体过大，请使用 15 MB 以内的参考音频')}return JSON.parse(body||'{}')}
const server=http.createServer(async(req,res)=>{try{
  const pathname=decodeURIComponent((req.url||'/').split('?')[0]);const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(pathname==='/api/milora')return await proxyMilora(url,res);
  if(pathname.startsWith('/api/temporary-audio/')){if(!serveTemporaryAudio(pathname,req,res)){res.writeHead(404,{'Cache-Control':'no-store'});res.end('Not Found')}return}
  if(pathname==='/api/aliyun/tts-http'&&req.method==='POST'){
    const input=await readJson(req);if(input.audioData)input.origin=publicOrigin(req);const result=await aliyunHttpTts(input);
    res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':String(result.buffer.length),...(result.voice?{'X-Voice-Id':result.voice}:{}),'Cache-Control':'no-store'});
    return res.end(result.buffer);
  }
  const safe=normalize(pathname==='/'?'/index.html':pathname);const file=join(root,safe);
  if(!file.startsWith(root)){res.writeHead(403);return res.end('Forbidden')}
  const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);
}catch(error){
  if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:error.message||'代理请求失败'}))}else res.destroy();
}});
server.listen(Number(process.env.PORT||4173),'0.0.0.0',()=>console.log('PWA server ready'));
