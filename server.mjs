import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const root=fileURLToPath(new URL('.',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml'};
const miloraEndpoint='https://api.milorapart.top/apis/mbAIsc';
const allowedAudioHosts=new Set(['media.milorapart.top','api.milorapart.top']);
const aliyunModel='qwen3-tts-vc-realtime-2025-11-27';

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

function wavFromPcm(pcm,sampleRate=24000){
  const header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVE',8);header.write('fmt ',12);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sampleRate,24);
  header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

function aliyunRealtimeTts({apiKey,model,voice,text,endpoint}){
  return new Promise((resolve,reject)=>{
    const modelId=model||aliyunModel;
    if(!/^qwen[0-9a-z.-]+$/i.test(modelId))return reject(new Error('模型 ID 格式无效，请填写百炼支持的 Qwen TTS Realtime 模型 ID'));
    let host;
    try{
      const u=new URL(endpoint||'https://dashscope.aliyuncs.com/api/v1');host=u.hostname;
      const publicHost=['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com'].includes(host);
      const workspaceHost=/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/i.test(host);
      if(!publicHost&&!workspaceHost)return reject(new Error('阿里云 Endpoint 必须是 DashScope 或北京/新加坡 Workspace 专属 API Host'));
    }catch{return reject(new Error('阿里云 Endpoint 格式无效'))}
    const ws=new WebSocket(`wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(modelId)}`,{headers:{Authorization:`Bearer ${apiKey}`}});
    const chunks=[];let settled=false;
    const timer=setTimeout(()=>finish(new Error('阿里云语音合成超时，请稍后重试')),90000);
    function finish(error,result){if(settled)return;settled=true;clearTimeout(timer);try{ws.close()}catch{};error?reject(error):resolve(result)}
    function sendEvent(event){ws.send(JSON.stringify({...event,event_id:`event_${randomUUID()}`}))}
    ws.on('message',raw=>{
      let event;try{event=JSON.parse(raw.toString())}catch{return}
      if(event.type==='error')return finish(new Error(`阿里云实时合成错误：${event.error?.message||event.error?.code||'未知错误'}`));
      if(event.type==='session.created')sendEvent({type:'session.update',session:{mode:'commit',voice,response_format:'pcm',sample_rate:24000,language_type:'Chinese'}});
      else if(event.type==='session.updated'){
        sendEvent({type:'input_text_buffer.append',text});
        sendEvent({type:'input_text_buffer.commit'});
      }else if(event.type==='response.audio.delta'&&event.delta)chunks.push(Buffer.from(event.delta,'base64'));
      else if(event.type==='response.done'){
        if(event.response?.status&&event.response.status!=='completed')return finish(new Error(`阿里云语音合成状态：${event.response.status}`));
        if(!chunks.length)return finish(new Error('阿里云合成成功但未返回音频'));
        sendEvent({type:'session.finish'});
      }else if(event.type==='session.finished')finish(null,wavFromPcm(Buffer.concat(chunks)));
    });
    ws.on('unexpected-response',(_req,res)=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>finish(new Error(`阿里云 WebSocket 握手失败（HTTP ${res.statusCode}）：${body.slice(0,500)}`)))});
    ws.on('error',error=>finish(new Error(`阿里云实时接口连接失败：${error.message}`)));
    ws.on('close',(code,reason)=>{if(!settled)finish(new Error(`阿里云连接已关闭（${code}）：${reason.toString()||'未收到完整合成结果'}`))});
  });
}

async function readJson(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>20*1024*1024)throw new Error('请求体过大')}return JSON.parse(body||'{}')}
const server=http.createServer(async(req,res)=>{try{
  const pathname=decodeURIComponent((req.url||'/').split('?')[0]);const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(pathname==='/api/milora')return await proxyMilora(url,res);
  if(pathname==='/api/aliyun/tts'&&req.method==='POST'){
    const input=await readJson(req);
    if(!input.apiKey||!input.voice||!input.text?.trim()){
      res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});
      return res.end(JSON.stringify({error:'缺少 API Key、voice 或合成文本'}));
    }
    const audio=await aliyunRealtimeTts(input);
    res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':String(audio.length),'Cache-Control':'no-store'});
    return res.end(audio);
  }
  const safe=normalize(pathname==='/'?'/index.html':pathname);const file=join(root,safe);
  if(!file.startsWith(root)){res.writeHead(403);return res.end('Forbidden')}
  const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);
}catch(error){
  if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:error.message||'代理请求失败'}))}else res.destroy();
}});
server.listen(Number(process.env.PORT||4173),'0.0.0.0',()=>console.log('PWA server ready'));
