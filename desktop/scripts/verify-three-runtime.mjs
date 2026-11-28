// Real Three/Vite/MCP acceptance in an isolated browser. Does not start Tauri.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { workspacePath, temporaryPath, repositoryRoot } from '../../scripts/workspace-paths.mjs';
import { createThreeRuntimeHarness } from './three-runtime-harness.mjs';

const run=`run-${Date.now()}`;
const output=workspacePath('tasks','3d-preview-implementation-20261108','three-runtime',run);
const scratch=temporaryPath('three-runtime-acceptance',run);
const fixture=path.resolve(fileURLToPath(new URL('../testdata/three-runtime-acceptance/', import.meta.url)));
await fs.mkdir(output,{recursive:true});await fs.mkdir(scratch,{recursive:true});
const project=path.join(scratch,'project'),profile=path.join(scratch,'browser-profile');
await fs.cp(fixture,project,{recursive:true});await fs.mkdir(profile);
const {createServer}=await import('../node_modules/vite/dist/node/index.js');
const server=await createServer({configFile:false,root:project,cacheDir:path.join(scratch,'vite-cache'),publicDir:false,
  resolve:{alias:[{find:/^three$/,replacement:path.join(repositoryRoot,'desktop/node_modules/three/build/three.module.js')},
    {find:'three/addons',replacement:path.join(repositoryRoot,'desktop/node_modules/three/examples/jsm')}]},
  server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[project,path.join(repositoryRoot,'desktop/node_modules')]}},
  optimizeDeps:{include:[]},logLevel:'warn'});
const proof={kind:'isolated headless Three.js + Vite HMR + production browser MCP',nativeWebView2:false,
  userDesktopControlled:false,paidProviderCalls:0,result:'running',checks:[],events:[],sources:{},expectedErrors:[]};
const sources=['desktop-services/src/tooling/browser/native-browser-service.mjs','desktop-services/src/tooling/browser/native-browser-mcp.mjs',
  'desktop/scripts/three-runtime-harness.mjs','desktop/scripts/verify-three-runtime.mjs',
  'desktop/testdata/three-runtime-acceptance/scene.js'];
for(const file of sources)proof.sources[file]=crypto.createHash('sha256').update(await fs.readFile(path.join(repositoryRoot,file))).digest('hex');
let harness;
const text=result=>result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
async function observe(predicate,label){
  const deadline=Date.now()+15000;let state;
  while(Date.now()<deadline){state=await harness.inspect();if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error(`${label}: ${JSON.stringify(state)}`);
}
async function capture(name){
  // The pinned MCP returns image blocks only when filename is omitted.
  const reply=await harness.tool('browser_take_screenshot',{type:'png',scale:'css'});
  const image=reply.content.find(item=>item.type==='image');
  assert.ok(image,'MCP snapshot must return image content to its consumer');
  const bytes=Buffer.from(image.data,'base64');await fs.writeFile(path.join(output,`returned-${name}`),bytes);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function settings(revision,roofColor,towerHeight,fail=false){return`export const settings = ${JSON.stringify({revision,roofColor,towerHeight,lightIntensity:3,fail})};\n`;}
try{
  await server.listen();const url=`http://127.0.0.1:${server.httpServer.address().port}/`;
  harness=await createThreeRuntimeHarness({repository:repositoryRoot,profile,projectRoot:project,output,events:proof.events});
  proof.browser=harness.browserVersion;proof.mcp=harness.initialized.serverInfo;
  await harness.tool('browser_navigate',{url});
  const initial=await observe(state=>state?.revision===1&&state.frames>3&&state.textureLoaded,'initial rendered scene');
  const advanced=await observe(state=>state?.frames>initial.frames+2,'animation continues');
  assert.equal(initial.instance,advanced.instance);
  proof.checks.push({name:'actual geometry, texture, lights and animation',state:advanced});
  await harness.tool('browser_evaluate',{function:'() => { window.threeRuntimeAcceptance.pause(true); window.threeRuntimeAcceptance.setCamera(); return window.threeRuntimeAcceptance.state(); }'});
  const before=await harness.inspect(),firstHash=await capture('stage-1.png');
  await fs.writeFile(path.join(project,'settings.js'),settings(2,'#a74438',2.6));
  const updated=await observe(state=>state?.revision===2,'file edit reaches existing scene through HMR');
  assert.equal(updated.instance,before.instance);assert.deepEqual(updated.camera,before.camera);
  const secondHash=await capture('stage-2.png');assert.notEqual(secondHash,firstHash);
  proof.checks.push({name:'saved module changes live pixels without replacing camera or document',beforeRevision:before.revision,afterRevision:updated.revision,firstHash,secondHash});
  await fs.writeFile(path.join(project,'settings.js'),settings(3,'#527278',1.9,true));
  let errorLog='';const deadline=Date.now()+15000;
  while(Date.now()<deadline){errorLog=text(await harness.tool('browser_console_messages',{level:'error',all:true}));if(errorLog.includes('three-runtime-synthetic-error'))break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.match(errorLog,/three-runtime-synthetic-error/);
  await fs.writeFile(path.join(output,'expected-runtime-error.txt'),errorLog);proof.expectedErrors.push('three-runtime-synthetic-error');
  const failed=await harness.inspect();assert.equal(failed.instance,before.instance);assert.equal(failed.revision,2);
  await fs.writeFile(path.join(project,'settings.js'),settings(4,'#447e59',2.1));
  const recovered=await observe(state=>state?.revision===4,'fixed module recovers live scene');
  assert.equal(recovered.instance,before.instance);assert.deepEqual(recovered.camera,before.camera);
  await capture('recovered.png');
  proof.checks.push({name:'runtime error reaches browser tool; corrected code recovers same scene',revision:recovered.revision});
  await harness.tool('browser_resize',{width:900,height:760});await capture('narrow.png');
  const state=await harness.service.snapshot({scope:harness.scope});
  assert.equal(state.activeLabel,'three-runtime-page');assert.ok(state.tabs.some(tab=>tab.url===url));
  assert.ok(proof.events.some(event=>event.topic==='nativeBrowserState'&&event.payload.inFlight>0));
  proof.checks.push({name:'browser tool targets hosted scene with scoped in-flight visualization',activeLabel:state.activeLabel,viewport:state.viewport});
  proof.result='pass';
}catch(error){proof.result='fail';proof.error=String(error.stack??error);process.exitCode=1;}
finally{
  await harness?.close();await server.close();
  await fs.writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify({result:proof.result,checks:proof.checks.length,output,error:proof.error}));
}
