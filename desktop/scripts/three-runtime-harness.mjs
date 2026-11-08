import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { probePlaywrightChromium } from '../../desktop-services/src/tooling/tool-browser-condition.mjs';
import { createNativeBrowserService, nativeBrowserScope } from '../../desktop-services/src/tooling/native-browser-service.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function socket(url) {
  const ws = new WebSocket(url), pending = new Map(); let sequence=0;
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error('headless CDP connection timeout')),10000);
    ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    ws.addEventListener('error',error=>{clearTimeout(timer);reject(error);},{once:true});
  });
  ws.addEventListener('message',event=>{
    const message=JSON.parse(String(event.data)), request=pending.get(message.id);
    if(request){clearTimeout(request.timer);pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);}
  });
  return { ws, send(method,params={}) { return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timeout`));},10000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });} };
}

/** All browser processes and pages are owned by this isolated acceptance run. */
export async function createThreeRuntimeHarness({ repository, profile, projectRoot, output, events }) {
  const probe=probePlaywrightChromium(); if(!probe.ok) throw new Error(probe.detail);
  const executable=path.join(probe.root,probe.build,'chrome-win64/chrome.exe');
  const engine=spawn(executable,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,
    '--no-first-run','--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'],{windowsHide:true,stdio:'ignore'});
  let browser,service,mcp;
  try {
    let info;
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){try{info=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');break;}catch{await delay(50);}}
    if(!info)throw new Error('owned headless engine did not start');
    const port=Number(info[0]);browser=await socket(`ws://127.0.0.1:${port}${info[1]}`);
    const list=async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(target=>target.type==='page');
    const first=(await list())[0];if(!first)throw new Error('owned initial page missing');
    const label='three-runtime-page',scope=nativeBrowserScope({projectRoot,conversationId:'three-runtime-acceptance'});
    const marker=`about:blank#trylo-native-${label}`;
    const record=()=>({scope,cdpPort:port,tabs:[{label,marker}],activeLabel:label});
    const pageCommand=async(method,params={})=>{
      const target=(await list()).find(value=>value.id===first.id); if(!target)throw new Error('owned scene page closed');
      const connection=await socket(target.webSocketDebuggerUrl);
      try{return await connection.send(method,params);}finally{connection.ws.close();}
    };
    await pageCommand('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(globalThis,'__tryloNativeView',{value:${JSON.stringify(label)}});`});
    await pageCommand('Page.navigate',{url:marker});
    service=createNativeBrowserService({emit:(topic,payload)=>events.push({topic,payload}),requestNative:async(key,operation)=>{
      if(key!==scope)throw new Error('headless scope mismatch');
      if(!['ensure','activate','layout','zoom'].includes(operation))throw new Error(`unneeded native operation ${operation}`);
      return record();
    }});
    const registration=await service.register({projectRoot,conversationId:'three-runtime-acceptance',record:record()});
    const child=spawn(process.execPath,[path.join(repository,'desktop-services/src/host.mjs'),'--native-browser-mcp',registration.endpoint,
      path.join(repository,'desktop-services/toolchain/browser/playwright-mcp/cli.js'),'--cdp-endpoint',registration.endpoint+'/',
      '--output-dir',output,'--image-responses','allow'],{windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:projectRoot});
    const pending=new Map();let sequence=0,diagnostic='';
    child.stderr.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-8000);});
    readline.createInterface({input:child.stdout}).on('line',line=>{
      const message=JSON.parse(line),request=pending.get(message.id);
      if(request){clearTimeout(request.timer);pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);}
    });
    const request=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timeout: ${diagnostic}`));},45000);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
    mcp={child,request,tool:async(name,args={})=>{
      const result=await request('tools/call',{name,arguments:args});if(result.isError)throw new Error(JSON.stringify(result));return result;
    }};
    const initialized=await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'three-runtime-acceptance',version:'1'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    return { ...mcp, service, scope, initialized, browserVersion:await browser.send('Browser.getVersion'),
      async close(){child.stdin.end();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(3000)]);if(child.exitCode===null)child.kill();await service.dispose();await browser.send('Browser.close').catch(()=>{});browser.ws.close();await Promise.race([new Promise(resolve=>engine.once('exit',resolve)),delay(2000)]);if(engine.exitCode===null)engine.kill();},
      async inspect(){return(await pageCommand('Runtime.evaluate',{expression:'window.threeRuntimeAcceptance?.state()',returnByValue:true})).result.value;},
    };
  }catch(error){mcp?.child.kill();await service?.dispose();await browser?.send('Browser.close').catch(()=>{});browser?.ws.close();if(engine.exitCode===null)engine.kill();throw error;}
}
