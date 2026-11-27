/** Trusted one-invocation broker. Candidate code is always a separate permission-restricted child. */
export const NPM_HARNESS = String.raw`
import {readFileSync,writeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
const config=JSON.parse(readFileSync(new URL('./input.json', import.meta.url),'utf8'));
const emit=value=>writeSync(1,JSON.stringify(value)+'\n');
const args=['--no-warnings','--permission','--allow-fs-read='+config.packageRoot,'--disable-proto=throw',config.entrypoint];
const env={};
async function cli(){
 return await new Promise(resolve=>{
  let stdout='',stderr='',overflow=false,settled=false;
  const child=spawn(config.node,args.concat(config.input.argv),{cwd:config.cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const finish=value=>{if(!settled){settled=true;resolve(value);}};
  const collect=(target,chunk)=>{
   const text=chunk.toString('utf8');
   if(target==='out')stdout+=text;else stderr+=text;
   if(Buffer.byteLength(stdout)>32768||Buffer.byteLength(stderr)>32768){overflow=true;child.kill();}
  };
  child.stdout.on('data',chunk=>collect('out',chunk));child.stderr.on('data',chunk=>collect('err',chunk));
  child.on('error',()=>finish({kind:'protocol_error',detail:'candidate spawn failed'}));
  child.stdin.on('error',()=>{ /* EPIPE is settled by the actual child exit; never replay stdin. */ });
  child.on('close',code=>finish(overflow?{kind:'protocol_error',detail:'candidate output exceeded capture bound'}:
   code===0?{kind:'value',value:{stdout,stderr,exitCode:0}}:{kind:'tool_error',code:'cli_exit_'+String(code),diagnostics:{stdout,stderr}}));
  child.stdin.end(config.input.stdin);
 });
}
async function library(){
 return await new Promise(resolve=>{
  let stdout='',stderr='',overflow=false,settled=false;
  const invocation=args.slice(0,-1).concat(path.join(config.packageRoot,'__trylo_library_runner__.cjs'));
  const child=spawn(config.node,invocation,{cwd:config.cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  const finish=value=>{if(!settled){settled=true;resolve(value);}};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const collect=(target,chunk)=>{
   if(overflow)return;
   const value=target==='out'?stdout:stderr,limit=target==='out'?65536:32768;
   if(Buffer.byteLength(value)+Buffer.byteLength(chunk)>limit){overflow=true;child.kill();return;}
   if(target==='out')stdout+=chunk;else stderr+=chunk;
  };
  child.stdout.on('data',chunk=>collect('out',chunk));child.stderr.on('data',chunk=>collect('err',chunk));
  child.on('error',()=>finish({kind:'protocol_error',detail:'adapter child spawn failed'}));
  child.stdin.on('error',()=>{ /* EPIPE is settled by child close; inputs are never replayed. */ });
  child.on('close',code=>{
   // The restricted adapter actually ran; excess/noisy output is its failure,
   // not evidence that the trusted broker or OS runtime is unavailable.
   if(overflow)return finish({kind:'tool_error',code:'npm_adapter_output_exceeded'});
   if(code!==0)return finish({kind:'tool_error',code:'library_exit_'+String(code)});
   try{
    const raw=JSON.parse(stdout);
    if(raw?.kind==='value'&&Object.keys(raw).length===2&&Object.hasOwn(raw,'value'))return finish(raw);
    if(raw?.kind==='tool_error'&&Object.keys(raw).length===2&&typeof raw.code==='string'&&/^[a-zA-Z0-9_.-]{1,200}$/.test(raw.code))return finish(raw);
   }catch{ /* Malformed or extra stdout is a terminal protocol failure, never inferred success. */ }
   finish({kind:'tool_error',code:'npm_adapter_result_protocol_invalid'});
  });
  child.stdin.end(JSON.stringify(config.input));
 });
}
async function mcp(){
 const {createMcpStdioClient}=await import('./trylo/internal/adapters/mcp-stdio/client.js');
 const client=createMcpStdioClient({serverId:'managed',command:config.node,args,env,cwd:config.cwd,protocolVersion:config.runtime.protocolVersion,handshakeTimeoutMs:5000,maxStderrBytes:32768});
 try{
  const connected=await client.connect();if(!connected.ok)return {kind:'protocol_error',detail:connected.code};
  const listed=await client.listTools();if(!listed.ok)return {kind:'protocol_error',detail:listed.code};
  if(config.operation==='inspect_mcp')return {kind:'value',value:{serverInfo:connected.value,tools:listed.value.map(tool=>({name:tool.serverToolName,description:tool.description,inputSchema:tool.inputSchema}))}};
  const tool=listed.value.find(item=>item.serverToolName===config.runtime.toolName);
  if(!tool||JSON.stringify(sort(tool.inputSchema))!==JSON.stringify(sort(config.schema)))return {kind:'protocol_error',detail:'frozen MCP schema does not match tools/list'};
  const called=await client.callTool({qualifiedName:tool.qualifiedName,arguments:config.input,timeoutMs:5000});
  if(!called.ok)return {kind:'protocol_error',detail:called.code};
  if(called.outcome.outcome==='error')return {kind:'tool_error',code:called.outcome.code,message:called.outcome.message.slice(0,2048)};
  if(called.outcome.outcome!=='result')return {kind:'protocol_error',detail:called.outcome.code??'MCP result unavailable'};
  return {kind:'value',value:{value:called.outcome.value,output:called.outcome.output}};
 }finally{await client.close();}
}
function sort(value){if(Array.isArray(value))return value.map(sort);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])]));return value;}
try{emit(await (config.runtime.profile==='confined_npm_cli_v1'?cli():config.runtime.profile==='confined_npm_library_v1'?library():mcp()));}
catch{emit({kind:'protocol_error',detail:'trusted broker could not complete the confined invocation'});}
`;
