import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {promisify} from 'node:util';
import {createStore} from '../src/store.mjs';import {createCredentialVault} from '../src/model-service/credentials.mjs';import {AMD_BASE,createAmdExecutor,normalizeAmdModels,isAmdSource} from '../src/model-service/amd.mjs';import {createModelService} from '../src/model-service/service.mjs';import {createRelayServer} from '../src/server.mjs';
const root=path.resolve('../output/amd-free-pool-20261025/test-data'),secret='synthetic-amd-key-not-a-real-credential';
const metadata={data:[{id:'chat-model',output:['text'],providers:[{streaming:true,tools:true,vision:true}],context_length:32768},{id:'voice-model',output:['audio'],providers:[{streaming:false}]},{id:'ocr-model',output:['ocr'],providers:[{ocr:true}]},{id:'decision-model',output:['decision']}]};
const config={name:'Synthetic AMD',endpoint:AMD_BASE,type:'free',protocol:'chat',unit:'requests',period:'day',models:['chat-model'],defaultLimit:1000,totalLimit:100000,concurrency:2};
const response=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
const payload={messages:[{role:'user',content:'Reply briefly.'}],max_tokens:64};
async function fixture(t,transport=async()=>response({choices:[{message:{content:'reply'}}]})){
 await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'case-')),store=await createStore(directory);
 await store.change(state=>{state.users=[{id:'owner',username:'operator',role:'admin'},{id:'other',username:'other'}];});
 const vault=await createCredentialVault({store,directory}),executor=createAmdExecutor({vault,transport}),service=await createModelService({store,vault,executor});
 await service.quota.saveUpstream(config,'owner');const id=service.snapshot().upstreams[0].id;await vault.save(service.quota.source(id),secret);await service.quota.setCatalog(id,normalizeAmdModels(metadata),'owner');await service.quota.setEnabled(id,true,'owner');
 await service.quota.saveGrant({userId:'owner',upstreamId:id,models:metadata.data.map(x=>x.id),limit:1000,expiresAt:'2030-01-01'},'owner');
 t.after(async()=>{await service.close();await store.close();if(!directory.startsWith(root+path.sep))throw Error('Cleanup outside test root');await fs.rm(directory,{recursive:true,force:true});});
 return{store,vault,executor,service,id,directory,request:extra=>({pool:'free',model:'chat-model',requestKey:crypto.randomUUID(),payload,...extra})};
}
test('credential encryption survives restart, binds endpoint, detects tampering, never appears in snapshots',async t=>{
 const f=await fixture(t),source=f.service.quota.source(f.id);assert.equal(f.vault.read(source),secret);
 const row=f.store.sqlRead(db=>db.prepare('SELECT ciphertext FROM model_credentials').get());assert.ok(!row.ciphertext.includes(secret));assert.ok(!JSON.stringify(f.service.snapshot()).includes(secret));
 const second=await createCredentialVault({store:f.store,directory:f.directory});assert.equal(second.read(source),secret);assert.equal(second.has({...source,endpoint:'https://evil.invalid/v1'}),false);assert.throws(()=>second.read({...source,endpoint:source.endpoint+'/other'}),e=>e.code==='credential_unavailable');
 await f.store.sqlWrite(db=>db.prepare('UPDATE model_credentials SET ciphertext=?').run('{}'));assert.throws(()=>second.read(source),e=>e.code==='credential_unavailable');
 await fs.rename(path.join(f.directory,'model-master.key'),path.join(f.directory,'model-master.key.backup'));await assert.rejects(createCredentialVault({store:f.store,directory:f.directory}),/original master key/);
});
test('catalog keeps every capability; exact-host adapter never accepts paid, lookalike or arbitrary endpoints',()=>{
 assert.equal(normalizeAmdModels(metadata).length,4);assert.equal(normalizeAmdModels(metadata)[1].chat,false);assert.equal(normalizeAmdModels(metadata)[0].streaming,true);
 for(const endpoint of [AMD_BASE+'.evil.invalid',AMD_BASE+'?key=bad','http://developer.amd.com.cn/radeon/api/v1','https://localhost/v1'])assert.equal(isAmdSource({...config,endpoint}),false);
 assert.equal(isAmdSource({...config,type:'plan'}),false);assert.throws(()=>normalizeAmdModels({data:[{id:'same'},{id:'same'}]}));
});
test('two encrypted accounts rotate within one grant, share quota, and survive vault reopen', async t => {
 const seen=[]; const second='synthetic-second-amd-key-for-rotation';
 const f=await fixture(t,async(url,init)=>{seen.push(init.headers.Authorization);return response({choices:[{message:{content:'reply'}}]});});
 const source=f.service.quota.source(f.id);await f.vault.save(source,second,'secondary');
 const reopened=await createCredentialVault({store:f.store,directory:f.directory});assert.equal(reopened.read(source,'secondary'),second);
 assert.deepEqual(reopened.slots(source),['primary','secondary']);await assert.rejects(reopened.save(source,second,'third'),e=>e.status===409);
 const grant=f.service.snapshot().grants[0];await f.service.quota.saveGrant({...grant,limit:3},'owner');
 for(let i=0;i<3;i++)await f.service.execute('owner',f.request());
 assert.deepEqual(seen,['Bearer '+secret,'Bearer '+second,'Bearer '+secret]);
 assert.equal(f.service.snapshot().grants.length,1);assert.equal(f.service.snapshot().upstreams[0].defaultLimit,1000);
 const quota=f.service.quota.userQuotas('owner').quotas[0];assert.equal(quota.used,3);assert.equal(quota.remaining,0);
 await assert.rejects(f.service.execute('owner',f.request()));assert.equal(seen.length,3);
 const snapshot=JSON.stringify(f.service.snapshot());assert.ok(!snapshot.includes(second)&&!snapshot.includes(secret));
 const stored=f.store.sqlRead(db=>db.prepare('SELECT ciphertext FROM model_credential_slots').get());assert.ok(!stored.ciphertext.includes(second));
 assert.throws(()=>reopened.read({...source,endpoint:source.endpoint+'/changed'},'secondary'),e=>e.code==='credential_unavailable');
});
test('a rejected account cools down without replay; the next separate request uses the healthy account',async t=>{
 const seen=[];const f=await fixture(t,async(url,init)=>{seen.push(init.headers.Authorization);return seen.length===1?new Response('{}',{status:429}):response({choices:[{message:{content:'reply'}}]});});
 await f.vault.save(f.service.quota.source(f.id),'synthetic-second-amd-account-key','secondary');
 await assert.rejects(f.service.execute('owner',f.request()),e=>e.code==='upstream_rejected');assert.equal(seen.length,1);
 const ledger=f.service.quota.requests('owner');assert.equal(ledger[0].status,'settled');assert.equal(ledger[0].used,1);
 await f.service.execute('owner',f.request());await f.service.execute('owner',f.request());
 assert.equal(seen.length,3);assert.ok(seen.slice(1).every(x=>x==='Bearer synthetic-second-amd-account-key'));
 assert.equal(f.service.quota.userQuotas('owner').quotas[0].used+f.service.quota.userQuotas('owner').quotas[0].reserved,3);
});
test('catalog refresh advertises only models supported by every pool account',async t=>{
 const f=await fixture(t,async(url,init)=>response(init.headers.Authorization==='Bearer '+secret?metadata:{data:[metadata.data[0],metadata.data[1]]}));
 await f.vault.save(f.service.quota.source(f.id),'synthetic-second-amd-account-key','secondary');
 const catalog=await f.executor.discover(f.service.quota.source(f.id));assert.deepEqual(catalog.map(x=>x.id),['chat-model','voice-model']);
});
test('CLI system blocks and continuation notes become one leading AMD instruction without dropping tool history',async t=>{
 const f=await fixture(t,async(url,init)=>{const body=JSON.parse(init.body);assert.deepEqual(body.messages,[{role:'system',content:'base\n\nworkspace\n\ncontinuation'}, {role:'user',content:'first'}, {role:'assistant',content:null,tool_calls:[{id:'tool',function:{name:'read_file',arguments:'{}'}}]}, {role:'tool',tool_call_id:'tool',content:'result'}, {role:'user',content:'next'}]);return response({choices:[{message:{content:'reply'}}]});});
 await f.service.execute('owner',f.request({payload:{...payload,messages:[{role:'system',content:'base'},{role:'system',content:'workspace'},{role:'user',content:'first'},{role:'assistant',content:null,tool_calls:[{id:'tool',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'tool',content:'result'},{role:'developer',content:[{type:'text',text:'continuation'}]},{role:'user',content:'next'}]}}));
 assert.equal(f.service.quota.userQuotas('owner').quotas[0].used,1);
});
test('an explicit AMD SSE rejection ends the request; a truncated stream remains uncertain',async t=>{
 const f=await fixture(t,async()=>new Response('event: error\ndata: {"error":{"code":"client_error"}}\n\nevent: done\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}));
 await assert.rejects(f.service.execute('owner',f.request({payload:{...payload,stream:true}}),undefined,()=>{}),error=>error.code==='upstream_rejected');
 assert.equal(f.service.quota.requests('owner')[0].status,'settled');
});
test('authorized free routing meters one actual call; replay, denied account and specialist misuse never dispatch',async t=>{
 let calls=0;const f=await fixture(t,async(url,init)=>{calls++;assert.equal(url,AMD_BASE+'/chat/completions');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+secret);const body=JSON.parse(init.body);assert.equal(body.model,'chat-model');assert.equal(body.max_tokens,64);assert.equal(body.endpoint,undefined);return response({choices:[{message:{content:'reply '+secret}}],usage:{total_tokens:3}});});
 const request=f.request();const result=await f.service.execute('owner',request);assert.match(result.result.choices[0].message.content,/redacted/);assert.equal(f.service.quota.userQuotas('owner').quotas[0].used,1);
 await assert.rejects(f.service.execute('owner',request),e=>e.status===409);await assert.rejects(f.service.execute('other',f.request()),e=>e.status===403);
 await assert.rejects(f.service.execute('owner',f.request({model:'voice-model'})),e=>e.code==='model_capability');await assert.rejects(f.service.execute('owner',f.request({payload:{...payload,max_tokens:100000}})),e=>e.status===400);
 assert.equal(calls,1);assert.equal(f.service.quota.requests('owner').length,1);assert.equal(f.service.userModels('owner').models.length,4);
});
test('unusable free quota never falls through to a separately authorized paid source',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return response({choices:[{message:{content:'reply'}}]});});
 await f.service.quota.saveUpstream({...config,type:'plan',name:'paid',models:['chat-model']},'owner');const paid=f.service.snapshot().upstreams.find(x=>x.type==='plan');await f.service.quota.setEnabled(paid.id,true,'owner');await f.service.quota.saveGrant({userId:'owner',upstreamId:paid.id,models:['chat-model'],limit:1000,expiresAt:'2030-01-01'},'owner');
 await f.service.quota.setEnabled(f.id,false,'owner');await assert.rejects(f.service.execute('owner',f.request()),e=>e.status===403);assert.equal(calls,0);
});
function streamResponse(complete){const wire='data: '+JSON.stringify({choices:[{delta:{content:'汉字🙂'}}]})+'\r\n\r\n'+(complete?'data: [DONE]\r\n\r\n':'');const bytes=Buffer.from(wire);return new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
test('stream parses split UTF-8 and CRLF, settles once; truncated stream retains uncertain count',async t=>{
 const good=await fixture(t,async()=>streamResponse(true)),chunks=[];await good.service.execute('owner',good.request({payload:{...payload,stream:true}}),undefined,chunk=>chunks.push(chunk));assert.equal(chunks[0].choices[0].delta.content,'汉字🙂');assert.equal(good.service.quota.requests('owner')[0].status,'settled');
 const bad=await fixture(t,async()=>streamResponse(false));await assert.rejects(bad.service.execute('owner',bad.request({payload:{...payload,stream:true}}),undefined,()=>{}),e=>e.code==='usage_uncertain');assert.equal(bad.service.quota.requests('owner')[0].status,'uncertain');assert.equal(bad.service.quota.userQuotas('owner').quotas[0].used,1);
});
test('changed source invalidates retained credential before any network dispatch',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return response({choices:[]});});await f.service.quota.saveUpstream({...config,id:f.id,endpoint:'https://other.invalid/v1'},'owner');
 assert.equal(f.service.snapshot().upstreams[0].credentialConfigured,false);await assert.rejects(f.service.execute('owner',f.request({upstreamId:f.id,pool:undefined})),e=>e.code==='adapter_unavailable');assert.equal(calls,0);
});
test('HTTP AMD setup reuses admin CSRF, exposes all models, and streams through the authorized account',async t=>{
 await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'http-')),password='synthetic-model-admin-password',salt=crypto.randomBytes(16).toString('hex'),passwordHash=(await promisify(crypto.scrypt)(password,salt,64)).toString('hex');
 const store=await createStore(directory);await store.change(state=>{state.users=[{id:'a',username:'operator',role:'admin',salt,passwordHash}];});await store.close();let modelCalls=0;
 const relay=await createRelayServer({dataDir:directory,enableAmd:true,secureCookies:false,webOrigin:'https://test.invalid',amdTransport:async(url)=>{if(url.endsWith('/models'))return response(metadata);modelCalls++;return streamResponse(true);}});await relay.listen(0);const base='http://127.0.0.1:'+relay.server.address().port;
 t.after(async()=>{await relay.close();await fs.rm(directory,{recursive:true,force:true});});
 async function call(route,{cookie,csrf,body,method=body?'POST':'GET'}={}){return fetch(base+route,{method,headers:{Origin:'https://test.invalid',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
 async function login(scope){const r=await call('/api/'+scope+'/login',{body:{username:'operator',password}}),cookie=r.headers.get('set-cookie').split(';')[0],s=await(await call('/api/'+scope+'/session',{cookie})).json();return{cookie,csrf:s.csrf};}
 const admin=await login('admin'),user=await login('account'),prefix='/api/admin/model-service';const saved=await(await call(prefix+'/upstreams',{...admin,body:config})).json(),id=saved.upstreams[0].id;
 assert.equal((await call(prefix+'/upstreams/'+id+'/credential',{cookie:admin.cookie,body:{apiKey:secret}})).status,403);assert.equal((await call(prefix+'/upstreams/'+id+'/credential',{...user,body:{apiKey:secret}})).status,401);
 const configured=await call(prefix+'/upstreams/'+id+'/credential',{...admin,body:{apiKey:secret}});assert.equal(configured.status,200);assert.ok(!(await configured.text()).includes(secret));
 const synced=await(await call(prefix+'/upstreams/'+id+'/catalog',{...admin,body:{}})).json();assert.equal(synced.upstreams[0].models.length,4);
 await call(prefix+'/grants',{...admin,body:{userId:'a',upstreamId:id,models:metadata.data.map(x=>x.id),limit:1000,expiresAt:'2030-01-01'}});await call(prefix+'/upstreams/'+id+'/enabled',{...admin,body:{enabled:true}});
 const list=await(await call('/api/account/models',user)).json();assert.equal(list.models.length,4);const r=await call('/api/account/model-requests',{...user,body:{pool:'free',model:'chat-model',requestKey:crypto.randomUUID(),payload:{...payload,stream:true}}});const wire=await r.text();assert.match(r.headers.get('content-type'),/text\/event-stream/);assert.match(wire,/汉字🙂/);assert.match(wire,/\[DONE\]/);assert.equal(modelCalls,1);
 const quota=await(await call('/api/account/model-quotas',user)).json();assert.equal(quota.quotas[0].used,1);
});
