import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const resources=path.resolve(process.argv[2]), evidence=path.resolve(process.argv[3]);
fs.mkdirSync(evidence,{recursive:true});
const outcomes=[];
for(const scenario of ['write-approved','write-denied','read-only','glob-read-only','grep-read-only']){
 const base=path.join(evidence,scenario),workspace=path.join(base,'workspace'),home=path.join(base,'home');
 fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(home,{recursive:true});
 const file=path.join(workspace,'effect.txt');
 const readOnly=scenario.includes('read-only');
 if(readOnly)fs.writeFileSync(file,'reader works');
 let requests=0,advertised=false,toolResultSeen=false;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":10}');return;}
  if(!req.url.includes('/messages')){res.writeHead(404);res.end('{}');return;}
  const input=JSON.parse(raw);requests++;
  const tool=scenario==='glob-read-only'?'Glob':scenario==='grep-read-only'?'Grep':readOnly?'Read':'Write';
  advertised ||= input.tools?.some(item=>item.name===tool)??false;
  const done=input.messages.some(message=>Array.isArray(message.content)&&message.content.some(block=>block.type==='tool_result'));
  toolResultSeen ||=done;
  const content=done?[{type:'text',text:'DONE'}]:[{type:'tool_use',id:'fixture-effect',name:tool,
   input:scenario==='glob-read-only'?{pattern:'*.txt',path:workspace}:scenario==='grep-read-only'?{pattern:'reader works',path:file,output_mode:'content'}:
    readOnly?{file_path:file}:{file_path:file,content:'legacy approved'}}];
  const message={id:'msg_local_fixture',type:'message',role:'assistant',model:input.model,content,
   stop_reason:done?'end_turn':'tool_use',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
  if(!input.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(message));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
  send('message_start',{message:{...message,content:[],stop_reason:null}});
  send('content_block_start',{index:0,content_block:done?{type:'text',text:''}:{...content[0],input:{}}});
  send('content_block_delta',{index:0,delta:done?{type:'text_delta',text:'DONE'}:{type:'input_json_delta',partial_json:JSON.stringify(content[0].input)}});
  send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}});
  send('message_stop',{});res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env={...process.env,PATH:'',USERPROFILE:home,HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),
  ANTHROPIC_BASE_URL:'http://127.0.0.1:'+server.address().port,ANTHROPIC_API_KEY:'local-smoke-key',ANTHROPIC_AUTH_TOKEN:'',
  ANTHROPIC_MODEL:'local-legacy-contract',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',TRYLO_DESKTOP_TOOL_POLICY:'1'};
 for(const key of Object.keys(env))if(/^(?:https?|all|no)_proxy$/i.test(key))delete env[key];env.NO_PROXY='127.0.0.1,localhost';
 const child=spawn(path.join(resources,'runtime/node/win-x64/node.exe'),[process.argv[4] || path.join(resources,'cli-legacy/cli.cjs'),'-p',
  '--input-format','stream-json','--output-format','stream-json','--verbose','--bare','--include-partial-messages',
  '--permission-prompt-tool','stdio','--permission-mode',readOnly?'plan':'default',
  '--tools='+(readOnly?'Read,Glob,Grep':'Read,Write')],{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='',stdout='',stderr='',approvals=0,timedOut=false;const frames=[];
 child.stderr.on('data',chunk=>stderr+=chunk);
 const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
 try{
  const completion=new Promise((resolve,reject)=>{
   child.on('error',reject);child.on('close',code=>resolve(code));
   child.stdout.on('data',chunk=>{
    stdout+=chunk;buffer+=chunk;
    try{for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;
     const frame=JSON.parse(line);frames.push(frame);
     if(frame.type==='result')setTimeout(()=>child.stdin.end(),100);
     if(frame.type==='control_request'&&frame.request?.subtype==='can_use_tool'){
      if(readOnly&&['Read','Glob','Grep'].includes(frame.request.tool_name)){
       child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,
        response:{behavior:'allow',updatedInput:frame.request.input}}})+'\n');continue;
      }
      assert.equal(frame.request.tool_name,'Write');assert.equal(fs.existsSync(file),false);approvals++;
      child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,
       response:scenario==='write-approved'?{behavior:'allow',updatedInput:frame.request.input}:{behavior:'deny',message:'fixture refuses'}}})+'\n');
     }
    }}catch(error){child.kill();reject(error);}
   });
  });
  child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'Use the named tool, then report the tool result.'}})+'\n');
  const exit=await completion;
  fs.writeFileSync(path.join(base,'stdout.ndjson'),stdout);fs.writeFileSync(path.join(base,'stderr.log'),stderr);
  assert.equal(timedOut,false);assert.equal(exit,0,stderr.slice(-3000));assert.ok(advertised,'expected reader/writer missing from provider catalog');
  assert.ok(toolResultSeen,'tool result did not return to provider');
  if(scenario==='write-approved'){assert.equal(approvals,1);assert.equal(fs.readFileSync(file,'utf8'),'legacy approved');}
  if(scenario==='write-denied'){assert.equal(approvals,1);assert.equal(fs.existsSync(file),false);}
  if(readOnly){
   assert.equal(approvals,0);assert.equal(fs.readFileSync(file,'utf8'),'reader works');
   const results=frames.filter(frame=>frame.type==='user').flatMap(frame=>frame.message?.content??[]).filter(block=>block.type==='tool_result');
   assert.ok(results.length>0);assert.ok(results.every(result=>!result.is_error),JSON.stringify(results));
   assert.ok(JSON.stringify(results).includes(scenario==='glob-read-only'?'effect.txt':'reader works'));
  }
  assert.equal(frames.filter(f=>f.type==='result').length,1);
  outcomes.push({scenario,passed:true,approvals,requests,noSystemNode:true});
 }finally{clearTimeout(timer);child.stdin.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(outcomes,null,2));console.log(JSON.stringify(outcomes));
