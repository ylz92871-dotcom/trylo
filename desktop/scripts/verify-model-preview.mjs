// Isolated real-WebGL/MCP acceptance. Never attaches to a user's browser or Desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { createModelPreviewService } from '../../desktop-services/src/tooling/model-preview-service.mjs';
import { runModelPreviewMcp } from '../../desktop-services/src/tooling/model-preview-mcp.mjs';
import { workspacePath } from '../../scripts/workspace-paths.mjs';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const shell = process.argv.includes('--shell');
const output = workspacePath('tasks', '3d-preview-implementation-20261108', 'webgl-acceptance', `run-${Date.now()}`);
const scratch = workspacePath('tmp', '3d-preview-webgl-20261108', `run-${Date.now()}`);
await fs.mkdir(output, { recursive: true }); await fs.mkdir(scratch, { recursive: true });
const sources=['src/components/app-shell/AppShell.tsx','src/components/preview/AgentModelPreviewWorkspace.tsx',
  'src/preview/agent-model-preview-bridge.ts','src/preview/use-agent-model-preview.ts','src/components/preview/useModelPreview.ts',
  'src/components/preview/modelViewer.ts','../desktop-services/src/tooling/model-preview-service.mjs'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sources.map(async file=>[file,createHash('sha256').update(await fs.readFile(path.resolve(desktop,file))).digest('hex')])));
const sourcesBefore=await sourceHashes();
const { build } = createRequire(new URL('../../desktop-services/package.json', import.meta.url))('esbuild');
const { chromium } = createRequire(new URL('../../desktop-services/toolchain/browser/playwright-mcp/package.json', import.meta.url))('playwright');
await build({ entryPoints: [path.join(desktop, 'testdata/model-preview-acceptance/fixture.tsx')],
  outdir: output, entryNames: 'fixture', bundle: true, splitting: true, platform: 'browser', format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env':JSON.stringify({MODE:'production',BASE_URL:'/',DEV:false,PROD:true}) },
  loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'file', '.png':'file', '.ttf':'file' },
  plugins:[{ name:'unused-shell-lazy-previews', setup(builder) {
    // The fixture never opens code/diff editors; retain the established test
    // stub instead of trying to implement Vite's unrelated ?worker transform.
    builder.onResolve({filter:/^monaco-editor$/},()=>({path:path.join(desktop,'src/components/code-surface/__mocks__/monaco-stub.ts')}));
    builder.onResolve({filter:/\/monaco-init$/},()=>({path:'unused-editor-init',namespace:'unused-editor'}));
    builder.onLoad({filter:/.*/,namespace:'unused-editor'},()=>({contents:'export async function initMonaco() {}',loader:'js'}));
    builder.onResolve({ filter:/.*/ }, args => args.kind === 'dynamic-import' && !args.path.endsWith('/ModelPreview') && args.path !== './ModelPreview'
      ? { path:args.path, external:true } : undefined);
  } }] });
const modelPath = path.join(scratch, 'assembly.obj');
const model = scale => `o Frame\nv 0 0 0\nv ${scale} 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 4 2\nf 1 3 4\nf 2 4 3\n`;
await fs.writeFile(modelPath, model(2));
let page;
let attached = false;
const diagnostics = [];
const service = createModelPreviewService({ emit(topic, payload) {
  void page?.evaluate(({ topic, payload }) => window.previewEvent(`tooling.${topic}`, payload), { topic, payload }).catch(error => diagnostics.push(String(error)));
} });
const rpc = {
  'tooling.modelPreviewAttach': () => { attached = true; return service.attach(); },
  'tooling.modelPreviewDetach': value => service.detach(value),
  'tooling.modelPreviewCommandResult': value => service.commandResult(value),
  'tooling.modelPreviewClose': value => service.close(value),
};
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const value = JSON.parse(body);
      if (url.pathname === '/rpc') {
        assert.ok(rpc[value.method]); response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(await rpc[value.method](value.params))); return;
      }
      if (url.pathname === '/__dev_preview/binary') {
        assert.equal(await fs.realpath(value.allowedRoot), await fs.realpath(scratch));
        const file = await fs.realpath(value.filePath);
        assert.ok(file.startsWith(await fs.realpath(scratch) + path.sep));
        response.end(await fs.readFile(file)); return;
      }
    }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>'); return;
    }
    const name = url.pathname.slice(1);
    assert.match(name, /^[a-zA-Z0-9_.-]+$/);
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await fs.readFile(path.join(output, name)));
  } catch (error) { response.writeHead(400); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const input = new PassThrough(), stdout = new PassThrough();
let nextId = 0, buffer = '';
const pending = new Map();
stdout.on('data', bytes => {
  buffer += bytes;
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter.resolve(message); }
  }
});
const call = (name, args = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject });
  input.write(`${JSON.stringify({ jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments:args } })}\n`);
});
let browser, browserServer, mcp;
const proof = { nativeDesktop: false, browserSurface: shell ? 'shell placeholder' : 'not present', shell,
  paidProviderCalls: 0, userDesktopControlled: false, sourcesBefore, checks: [], diagnostics };
try {
  browserServer = await chromium.launchServer({ headless: true, channel: 'msedge', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  browser = await chromium.connect(browserServer.wsEndpoint());
  page = await browser.newPage({ viewport:{ width:1440, height:900 }, deviceScaleFactor:1 });
  page.on('pageerror', error => { diagnostics.push(error.message); console.error(`fixture pageerror: ${error.message}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/?root=${encodeURIComponent(scratch)}${shell ? '&shell' : ''}`);
  await page.waitForFunction(() => typeof window.previewEvent === 'function');
  const attachDeadline=Date.now()+30000;
  while (!attached && Date.now()<attachDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(attached,`fixture bridge did not attach: ${diagnostics.join('; ')}`);
  const connection = await service.configure({ projectRoot:scratch, conversationId:'scene-a' });
  mcp = runModelPreviewMcp({ gate:connection.gate, stdin:input, stdout });
  const opened = await call('preview_open', { path:modelPath });
  assert.equal(opened.result.isError, false, JSON.stringify(opened));
  const metadata = JSON.parse(opened.result.content[0].text);
  assert.equal(metadata.status, 'ready'); assert.equal(metadata.scene.triangles, 4);
  const initialSignature=createHash('sha256').update(model(2)).digest('hex');
  assert.equal(metadata.fileSignature,initialSignature);
  proof.checks.push({ openReady: true, scene: metadata.scene, revision: metadata.revision, fileSignature:metadata.fileSignature });
  await call('preview_view', { preset:'front', wireframe:true });
  const snapshot = await call('preview_snapshot');
  const image = snapshot.result.content.find(item => item.type === 'image');
  assert.equal(image.mimeType, 'image/jpeg');
  await fs.writeFile(path.join(output, 'model-frame.jpg'), Buffer.from(image.data, 'base64'));
  const before = JSON.parse(snapshot.result.content.find(item => item.type === 'text').text);
  assert.equal(before.wireframe, true);
  assert.equal(before.fileSignature,initialSignature);
  if (shell) {
    const toggle=page.getByRole('button',{name:'3D 工作区',exact:true});
    await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
    await page.locator('.agent-model-scene--visible').waitFor();
    await toggle.click();
    await page.waitForFunction(()=>document.querySelectorAll('.agent-model-scene--visible').length===0);
    const hidden=await call('preview_snapshot');
    assert.ok(hidden.result.content.some(item=>item.type==='image'));
    await toggle.click();await page.locator('.agent-model-scene--visible').waitFor();
    const restored=JSON.parse((await call('preview_snapshot')).result.content.find(item=>item.type==='text').text);
    assert.equal(restored.version,before.version);assert.equal(restored.revision,before.revision);
    proof.checks.push({shellDockAutoOpens:true,collapseRetainsScene:true});
    await page.getByRole('button',{name:'浏览器侧栏',exact:true}).click();
    await page.locator('.browser-tool-sidebar').waitFor();
    assert.equal(await page.locator('.agent-model-scene--visible').count(),0);
    await toggle.click();await page.locator('.agent-model-scene--visible').waitFor();
    assert.equal(await page.locator('.browser-tool-sidebar').count(),0);
    await page.getByRole('button',{name:'放大 3D 工作区',exact:true}).click();
    const expanded=await page.locator('.agent-model-scene--expanded').boundingBox();
    assert.ok(expanded&&expanded.width>=1439&&expanded.height>=899);
    await page.screenshot({path:path.join(output,'shell-expanded.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelectorAll('.agent-model-scene--expanded').length===0);
    const panel=page.locator('.agent-model-scene--visible');const widthBefore=(await panel.boundingBox()).width;
    const separator=await page.getByRole('separator',{name:'Resize file panel',exact:true}).boundingBox();
    assert.ok(separator);await page.mouse.move(separator.x+separator.width/2,separator.y+120);await page.mouse.down();
    await page.mouse.move(separator.x-100,separator.y+120,{steps:6});await page.mouse.up();
    assert.ok((await panel.boundingBox()).width>widthBefore+70);
    proof.checks.push({shellBrowserAndModelMutuallyExclusive:true,fullscreenExit:true,resizeChangesDock:true});
  }
  await page.screenshot({ path:path.join(output, 'workspace-desktop.png') });
  await fs.writeFile(modelPath, model(3));
  const changed = await call('preview_snapshot');
  const after = JSON.parse(changed.result.content.find(item => item.type === 'text').text);
  assert.notEqual(after.revision, before.revision); assert.equal(after.wireframe, true);
  assert.notEqual(changed.result.content.find(item => item.type === 'image').data, image.data);
  assert.deepEqual(after.camera, before.camera);
  assert.equal(after.fileSignature,createHash('sha256').update(model(3)).digest('hex'));
  proof.checks.push({ fileUpdatePreservesCamera:true, revisionChanged:true, renderedFileSignature:after.fileSignature });
  await page.getByRole('button', { name:'切换聊天' }).click();
  await page.getByText('当前聊天：scene-b').waitFor();
  assert.equal(await page.locator('.agent-model-scene--visible').count(), 0);
  const background = await call('preview_snapshot');
  assert.ok(background.result.content.some(item => item.type === 'image'));
  proof.checks.push({ backgroundSceneStillCaptures:true, currentConversationNotRetargeted:true });
  await page.getByRole('button', { name:'切换聊天' }).click();
  await page.setViewportSize({ width:900, height:760 });
  await page.screenshot({ path:path.join(output, 'workspace-narrow.png') });
  const rect = await page.locator('.agent-model-scene--visible').boundingBox();
  assert.ok(rect && rect.width >= 300 && rect.x + rect.width <= 901);
  if(shell){
    const layout=await page.evaluate(()=>{
      const main=document.querySelector('.app-shell__main').getBoundingClientRect();
      const dock=document.querySelector('.agent-model-scene--visible').getBoundingClientRect();
      return{mainWidth:main.width,dockRight:dock.right,rootScrollWidth:document.documentElement.scrollWidth,innerWidth};
    });
    assert.ok(layout.mainWidth>=350);assert.ok(layout.rootScrollWidth<=layout.innerWidth);
    proof.checks.push({shellNarrowDoesNotOverflow:true,layout});
  }
  await call('preview_close');
  await page.waitForFunction(() => document.querySelectorAll('.agent-model-scene').length === 0);
  assert.deepEqual(diagnostics, []);
  proof.checks.push({ closeDisposesScene:true, narrowLayoutFits:true });
  proof.passed = true;
} catch (error) {
  if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  proof.passed = false; proof.error = String(error.stack ?? error); throw error;
} finally {
  proof.sourcesAfter=await sourceHashes();
  proof.sourceStable=JSON.stringify(proof.sourcesBefore)===JSON.stringify(proof.sourcesAfter);
  if(!proof.sourceStable){proof.passed=false;proof.sourceDrift='product sources changed during acceptance';process.exitCode=1;}
  await fs.writeFile(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2));
  const cleanup=[];
  console.log('cleanup: stopping owned MCP client');
  input.end(); const mcpController=await mcp?.catch(() => undefined); mcpController?.stop(); cleanup.push('mcp stopped');
  console.log('cleanup: closing owned browser');
  let forcedOwnedBrowser=false;
  const browserClose=browser?.close().catch(()=>{});
  let closeTimer;
  await Promise.race([browserClose,new Promise(resolve=>{
    // Test-harness cleanup only: never leave an owned software-renderer process
    // behind when its close handshake stalls. This cannot target a user browser.
    closeTimer=setTimeout(()=>{forcedOwnedBrowser=true;void browserServer?.kill().finally(resolve);},5000);
  })]);
  clearTimeout(closeTimer);
  if(browserServer)await browserServer.close().catch(()=>{});
  cleanup.push(forcedOwnedBrowser?'owned browser killed after close handshake stalled':'browser closed');
  console.log('cleanup: disposing owned preview service');
  await service.dispose(); cleanup.push('preview service disposed');
  console.log('cleanup: closing owned fixture endpoint');
  const fixtureClosed=new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await fixtureClosed;
  cleanup.push('fixture endpoint closed');
  await fs.writeFile(path.join(output,'cleanup.json'),JSON.stringify({completed:true,forcedOwnedBrowser,steps:cleanup},null,2));
}
console.log(JSON.stringify({ passed:proof.passed, checks:proof.checks.length, output }));
