// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import { settingsDefaults } from '../settings/settings-store';
import { contextModelKey } from '../settings/context-window';
import { settingsForCodeRun } from '../runtime/conversation-run-supervisor';
import { sendWorkChat } from '../work-chat/work-chat-adapter';
import { platformModelConnection } from '../account/platform-models';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';
const h=vi.hoisted(()=>({service:null as ProcessService|null}));
vi.mock('./index',()=>({hostAdapter:{get process(){return h.service;}}}));
vi.mock('../runtime/cli-runtime-guard',()=>({verifyCliRuntime:vi.fn(async()=>({ok:true}))}));
vi.mock('../account/platform-models',()=>({platformModelConnection:vi.fn()}));
const {CodeRunController}=await import('../runtime/code-run-controller');

it('Work adapter → controller → actual CLI sends pool effort and clamps context to catalog capacity',async()=>{
  const root=mkdtempSync(join(tmpdir(),'trylo-work-context-')),workspace=join(root,'workspace'),home=join(root,'home');mkdirSync(workspace);mkdirSync(home);execFileSync('git',['init','--quiet',workspace],{windowsHide:true});
  const payloads:Record<string,unknown>[]=[];
  const server=createServer((request,response)=>{let text='';request.on('data',chunk=>{text+=String(chunk);});request.on('end',()=>{payloads.push(JSON.parse(text));response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: {"choices":[{"delta":{"content":"WORK_CONTEXT_WIRE_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('Missing fixture port');
  vi.mocked(platformModelConnection).mockResolvedValue({apiHost:`http://127.0.0.1:${address.port}/v1`,apiKey:'synthetic-model-capability',apiModel:'Qwen3.8-Flash-Next',providerId:'openai-compatible',apiFormat:'openai',modelContextWindow:262144});
  const service=new NodeProcessFixture({...process.env,TRYLO_HOME:home,TRYLO_API_KEY:'',TRYLO_OPENAI_API_KEY:''});h.service=service;
  const controller=new CodeRunController({projectKey:'work',conversationId:'pool-context',onChange(){},permissions:new CodePermissionRegistry({onChange(){},send:async()=>true})});
  const settings={...settingsDefaults,cliPath:resolve('../new trylo cli/dist/cmd/trylo/main.js'),cliRuntimeProtocol:'trylo-v1' as const,poolModel:'Qwen3.8-Flash-Next',apiKey:'private-key-must-stay-private',reasoningEffort:'high' as const};
  const key=contextModelKey(settings);
  const configured={...settings,modelContextPreferences:{[key]:{window:400000}},modelReasoningPreferences:{[key]:'low' as const}};
  let finish!:()=>void;const terminal=new Promise<void>(done=>{finish=done;});let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await sendWorkChat({runCode:(_project,_conversation,request)=>controller.run(request)},{projectKey:'work',conversationId:'pool-context',text:'Reply WORK_CONTEXT_WIRE_OK, without any tools.',settings:{...settingsForCodeRun(configured,workspace),cliNodeProgram:process.execPath},permissionLevel:'read_only',priorMessages:[],onEvents:events=>{if(events.some(event=>event.type==='loop_end'))finish();}});
    await Promise.race([terminal,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Work CLI did not finish')),45000);})]);
    await Promise.all(service.exits.values());
    expect(payloads).toHaveLength(1);expect(payloads[0]).toMatchObject({model:'Qwen3.8-Flash-Next',reasoning_effort:'low'});
    const frames=service.wire.map(line=>{try{return JSON.parse(line);}catch{return {};}});
    expect(frames.find(frame=>frame.type==='run_start')?.contextWindow).toBe(262144);
    expect(frames.find(frame=>frame.type==='run_result')).toMatchObject({status:'completed',lastMessage:'WORK_CONTEXT_WIRE_OK'});
    expect(JSON.stringify(service.argv)).not.toContain('private-key-must-stay-private');
  }finally{clearTimeout(timer);for(const id of service.children.keys())await service.stop(id).catch(()=>{});server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
},60000);
