// Real shared shell + real native backend. Does not control the user's desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createSoftwareWorkspace } from '../../desktop-services/src/tooling/software-workspace-service.mjs';
import { createToolCatalog } from '../../desktop-services/src/tooling/tool-catalog.mjs';
import { createToolPackageManager } from '../../desktop-services/src/tooling/tool-package-manager.mjs';
import { resolveComputerPreviewPython } from '../../desktop-services/src/tooling/computer-control/windows/computer-preview-stream.mjs';
import { workspacePath } from '../../scripts/workspace-paths.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const desktop = path.join(root, 'desktop');
const output = workspacePath('tasks', 'software-workspace-implementation-20261110', `ui-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const modelInput = process.argv.find(value => value.startsWith('--model='))?.slice(8);
const advisorySha = process.argv.find(value => value.startsWith('--advisory-sha='))?.slice(15);
const catalog = createToolCatalog();
const packages = createToolPackageManager({ catalog, storageRoot: output, enableRepositoryTools: true });
const python = await resolveComputerPreviewPython({ catalog, packages });
assert.ok(python);
const { build } = createRequire(new URL('../../desktop-services/package.json', import.meta.url))('esbuild');
const { chromium } = createRequire(new URL('../../desktop-services/toolchain/browser/playwright-mcp/package.json', import.meta.url))('playwright');
await build({ entryPoints: [path.join(desktop, 'testdata/software-workspace-acceptance/fixture.tsx')], bundle: true,
  outdir: output, format: 'esm', platform: 'browser', target: 'chrome120', loader: { '.svg': 'file', '.png': 'file', '.ttf': 'file', '.woff2': 'file' },
  plugins: [{ name: 'unused-editor', setup(builder) {
    builder.onResolve({ filter: /^monaco-editor$/ }, () => ({ path: path.join(desktop, 'src/components/code-surface/__mocks__/monaco-stub.ts') }));
    builder.onResolve({ filter: /\/monaco-init$/ }, () => ({ path: 'unused-init', namespace: 'unused-editor' }));
    builder.onLoad({ filter: /.*/, namespace: 'unused-editor' }, () => ({ contents: 'export async function initMonaco() {}', loader: 'js' }));
    builder.onResolve({ filter: /.*/ }, args => args.kind === 'dynamic-import' ? { path: args.path, external: true } : undefined);
  } }] });
let page;
const diagnostics = [];
const service = createSoftwareWorkspace({ storageRoot: output, emit(topic, value) {
  void page?.evaluate(({ topic, value }) => window.softwareEvent(`tooling.${topic}`, value), { topic, value }).catch(() => {});
}, resolveRuntime: async () => ({ executable: python,
  entry: path.join(root, 'desktop-services/toolchain/software-workspace/controller.py') }) });
const scope = { projectRoot: output, conversationId: 'software-acceptance' };
async function openSolidworks() {
  assert.match(advisorySha ?? '', /^[a-f0-9]{64}$/i, 'Use the digest of a visually reviewed startup advisory for this native harness');
  const base = path.join(process.env.APPDATA, 'me.trylocode.trylo/Trylo/tool-packages/solidworks-mcp/1.3.0');
  const { gate } = await service.configure({ ...scope, packageId: 'solidworks-mcp', server: {
    command: path.join(base, '.venv/Scripts/python.exe'), args: [path.join(base, 'mcp-server/server.py')], env: { PYTHONUTF8: '1' } } });
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch(gate + '/api', { method: 'POST', signal: AbortSignal.timeout(90000), body: JSON.stringify({ packageId: 'solidworks-mcp', clientId: 'native-ui-acceptance', message: { jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: ++id }), method, params } }) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'UI acceptance', version: '1' } });
  await rpc('notifications/initialized');
  const state = await service.command({ ...scope, operation: 'status' });
  const installed = state.installed.find(app => app.kind === 'solidworks'); assert.ok(installed);
  await service.command({ ...scope, operation: 'open', input: { path: installed.path } });
  const deadline = Date.now() + 100000;
  let connected = false, acknowledged = false;
  while (Date.now() < deadline) {
    const observed = await service.command({ ...scope, operation: 'status' });
    const dialog = observed.windows.find(window => window.dialog && window.title === 'SOLIDWORKS');
    if (dialog && !acknowledged) {
      const picture = await service.command({ ...scope, operation: 'snapshot', input: { mode: 'window', windowId: dialog.id } });
      const bytes = Buffer.from(picture.data, 'base64');
      await fs.writeFile(path.join(output, 'startup-advisory.jpg'), bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex').toLowerCase(), advisorySha.toLowerCase(), 'Unknown dialog is never automatically acknowledged');
      const ok = dialog.controls.find(control => control.className === 'Button' && control.text === '确定'); assert.ok(ok);
      await service.command({ ...scope, operation: 'control', input: { heldByUser: true } });
      await service.command({ ...scope, operation: 'input', input: { kind: 'click', windowId: dialog.id, x: (ok.rect[0] + ok.rect[2]) / 2 - dialog.rect[0], y: (ok.rect[1] + ok.rect[3]) / 2 - dialog.rect[1] } });
      await service.command({ ...scope, operation: 'control', input: { heldByUser: false } }); acknowledged = true;
    }
    if (observed.windows.some(window => !window.dialog && window.title.includes('SOLIDWORKS'))) {
      const value = await rpc('tools/call', { name: 'solidworks_connect', arguments: { params: { wait_seconds: 1 } } });
      if (JSON.parse(value.result.content[0].text).status === 'ok') { connected = true; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(connected, 'owned SW instance registered');
  const destination = path.join(output, 'UI-model.SLDPRT'); await fs.copyFile(path.resolve(modelInput), destination);
  const opened = await rpc('tools/call', { name: 'solidworks_open_document', arguments: { params: { path: destination, read_only: true, silent: true } } });
  assert.equal(JSON.parse(opened.result.content[0].text).status, 'ok', JSON.stringify(opened));
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/rpc') {
      let body = ''; for await (const part of request) body += part;
      const value = JSON.parse(body);
      assert.equal(value.method, 'tooling.softwareWorkspace');
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await service.command(value.params))); return;
    }
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<div id="root"></div><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script>'); return; }
    const name = url.pathname.slice(1); assert.match(name, /^[a-zA-Z0-9_.-]+$/);
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(await fs.readFile(path.join(output, name)));
  } catch (error) { response.writeHead(409); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => diagnostics.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/?root=${encodeURIComponent(output)}`);
  await page.getByRole('button', { name: '软件工作区', exact: true }).click();
  await page.getByText('把软件留在任务里').waitFor();
  await page.screenshot({ path: path.join(output, 'code-empty.png') });
  if (modelInput) await openSolidworks();
  else await service.command({ ...scope, operation: 'open', input: { path: python, args: ['-B', path.join(root, 'desktop-services/tests/fixtures/software-workspace.py')] } });
  const image = page.locator('.software-workspace__canvas img');
  await image.waitFor();
  if (modelInput) await page.getByRole('button', { name: '模型视图', exact: true }).click();
  await page.getByRole('button', { name: '接管操作' }).click();
  await page.getByRole('button', { name: '交还模型' }).waitFor();
  const before = await image.getAttribute('src');
  if (modelInput) await page.getByRole('combobox', { name: '模型方向' }).selectOption('right');
  else {
    const bounds = await image.boundingBox();
    const dimensions = await image.evaluate(element => [element.naturalWidth, element.naturalHeight]);
    await page.mouse.click(bounds.x + 100 * bounds.width / dimensions[0], bounds.y + 90 * bounds.height / dimensions[1]);
  }
  await page.waitForFunction(before => document.querySelector('.software-workspace__canvas img')?.getAttribute('src') !== before, before);
  if (modelInput) {
    await page.screenshot({ path: path.join(output, 'right-view.png') });
    const right = await image.getAttribute('src');
    await page.getByRole('combobox', { name: '模型方向' }).selectOption('isometric');
    await page.waitForFunction(previous => document.querySelector('.software-workspace__canvas img')?.getAttribute('src') !== previous, right);
  }
  await page.screenshot({ path: path.join(output, 'code-live.png') });
  await page.getByRole('button', { name: '浏览器侧栏', exact: true }).click();
  assert.equal(await page.locator('.software-workspace').count(), 0, 'browser navigation owns the selected rail');
  await page.getByRole('button', { name: '软件工作区', exact: true }).click();
  await image.waitFor();
  await page.getByRole('button', { name: '切换 Code / Work' }).click();
  await image.waitFor();
  await page.screenshot({ path: path.join(output, 'work-live.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(output, 'work-dark.png') });
  await page.setViewportSize({ width: 640, height: 860 });
  await page.screenshot({ path: path.join(output, 'narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '隐藏软件工作区' }).click();
  assert.equal((await service.command({ ...scope, operation: 'status' })).applications[0].running, true, 'hiding preserves native software');
  await page.getByRole('button', { name: '软件工作区', exact: true }).click();
  await page.getByRole('button', { name: '结束软件工作区', exact: true }).click();
  await page.getByRole('button', { name: '结束工作区', exact: true }).click();
  await page.getByText('工作区已结束', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'stopped.png') });
  await page.getByRole('button', { name: '切换验收对话' }).click();
  await page.getByText('把软件留在任务里').waitFor();
  assert.equal(await page.locator('.software-workspace__canvas img').count(), 0, 'conversation switch clears old pixels');
  assert.deepEqual(diagnostics, []);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, nativeDesktop: false, nativeBackend: true, paidProviderCalls: 0, diagnostics }, null, 2));
  console.log(JSON.stringify({ ok: true, output }));
} finally { await browser?.close(); await service.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
