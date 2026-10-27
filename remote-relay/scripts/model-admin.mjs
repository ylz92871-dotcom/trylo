// Offline maintenance entrypoint. Stop the relay before importing into its DB.
import fs from 'node:fs/promises';import {createStore} from '../src/store.mjs';import {createModelQuota} from '../src/model-service/quota.mjs';import {createCredentialVault} from '../src/model-service/credentials.mjs';import {AMD_BASE,createAmdExecutor} from '../src/model-service/amd.mjs';
import crypto from 'node:crypto';import {createModelService} from '../src/model-service/service.mjs';
async function main(){
const command=process.argv[2];if(!['import-amd','add-amd-account'].includes(command))throw Error('Expected AMD maintenance command');
const directory=process.env.RELAY_DATA_DIR;if(!directory)throw Error('RELAY_DATA_DIR required');
const chunks=[];for await(const chunk of process.stdin){chunks.push(chunk);if(Buffer.concat(chunks).length>2048)throw Error('Credential input too long');}
const secret=Buffer.concat(chunks).toString('utf8').trim();if(!/^rc-[a-zA-Z0-9]{30,100}$/.test(secret))throw Error('AMD credential input required');
const store=await createStore(directory);
try{
 const admin=store.read().users.find(user=>user.username.toLowerCase()==='ylz'&&user.role==='admin'&&!user.disabled);if(!admin)throw Error('Existing owner administrator required');
 const quota=await createModelQuota({store,userConcurrency:1}),vault=await createCredentialVault({store,directory}),executor=createAmdExecutor({vault});
 const existing=quota.snapshot().upstreams.find(item=>item.type==='free'&&item.endpoint.replace(/\/$/,'')===AMD_BASE);
 if(command==='add-amd-account'){
  if(!existing||!existing.enabled||existing.unit!=='requests'||existing.period!=='day'||existing.defaultLimit!==1000)throw Error('Existing 1000/day AMD pool required');
  const source=quota.source(existing.id),before=quota.userQuotas(admin.id).quotas.find(item=>item.upstreamId===existing.id);
  if(!before||before.limit!==1000)throw Error('Existing owner grant required');
  if(vault.slots(source).includes('secondary')&&vault.read(source,'secondary')!==secret)throw Error('A different secondary account is already configured');
  const candidate=createAmdExecutor({vault:{has:()=>true,slots:()=>['secondary'],read:()=>secret}});
  const catalog=await candidate.discover(source);
  if(!source.models.every(id=>catalog.some(item=>item.id===id)))throw Error('Second account cannot serve every existing pool model');
  await vault.save(source,secret,'secondary');await quota.credentialAudit(source.id,admin.id);
  const common=await executor.discover(source);await quota.setCatalog(source.id,common,admin.id);
  const statesBefore=executor.members(source),service=await createModelService({store,vault,executor,requestTimeoutMs:90000}),probes=[];
  try{for(const stream of [false,true]){let events=0;await service.execute(admin.id,{pool:'free',model:'Qwen3.8-Flash-Next',requestKey:crypto.randomUUID(),payload:{messages:[{role:'user',content:'Reply with only AMD_OK.'}],max_tokens:128,stream}},undefined,stream?()=>{events++;}:undefined);probes.push({stream,ok:true,events});}}finally{await service.close();}
  const members=executor.members(source).map(item=>({slot:item.slot,probeCalls:item.dispatched-statesBefore.find(before=>before.slot===item.slot).dispatched,status:item.status}));
  if(members.length!==2||!members.every(item=>item.probeCalls===1&&item.status===200))throw Error('Expected one successful request per AMD account');
  const after=quota.userQuotas(admin.id).quotas.find(item=>item.upstreamId===source.id);
  console.log(JSON.stringify({upstreamId:source.id,models:common,slots:vault.slots(source),members,probes,perAccountDailyRequests:1000,sharedDailyLimit:source.totalLimit,ownerUsedBefore:before.used,ownerUsed:after.used,grantPreserved:before.id===after.id,credentialEncrypted:true,otherUsersAutoGranted:false}));
  return;
 }
 if(existing)throw Error('AMD pool already exists; use administrator controls');
 await quota.saveUpstream({name:'AMD 免费池',type:'free',endpoint:AMD_BASE,protocol:'chat',models:['Qwen3.8-Flash-Next'],unit:'requests',period:'day',defaultLimit:1000,totalLimit:100000,concurrency:2},admin.id);
 const source=quota.snapshot().upstreams.find(item=>item.endpoint.replace(/\/$/,'')===AMD_BASE);
 await vault.save(source,secret);await quota.credentialAudit(source.id,admin.id);
 const catalog=await executor.discover(source);await quota.setCatalog(source.id,catalog,admin.id);
 const expiresAt=new Date(Date.now()+365*86400000+8*3600000).toISOString().slice(0,10);
 await quota.saveGrant({userId:admin.id,upstreamId:source.id,models:catalog.map(item=>item.id),limit:1000,expiresAt},admin.id);
 await quota.setEnabled(source.id,true,admin.id);
 const service=await createModelService({store,vault,executor,requestTimeoutMs:90000});const probes=[];
 try{for(const stream of [false,true]){let events=0;await service.execute(admin.id,{pool:'free',model:'Qwen3.8-Flash-Next',requestKey:crypto.randomUUID(),payload:{messages:[{role:'user',content:'Reply with only AMD_OK.'}],max_tokens:128,stream}},undefined,stream?()=>{events++;}:undefined);probes.push({stream,ok:true,events});}}finally{await service.close();}
 console.log(JSON.stringify({upstreamId:source.id,name:source.name,models:catalog,ownerGranted:true,otherUsersAutoGranted:false,perAccountDailyRequests:1000,sharedDailyLimit:100000,globalConcurrency:4,userConcurrency:1,upstreamConcurrency:2,credentialEncrypted:true,probes,ownerUsed:quota.userQuotas(admin.id).quotas[0].used}));
}finally{await store.close();}
}
main().catch(()=>{console.error('AMD import failed. Inspect configuration; no credential content is logged.');process.exitCode=1;});
