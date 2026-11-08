// Acceptance of the real MCP adapter against an isolated headless engine.
// This intentionally does NOT start Tauri or claim native WebView2 acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createNativeBrowserService, nativeBrowserScope } from '../src/tooling/native-browser-service.mjs';
import { probePlaywrightChromium } from '../src/tooling/tool-browser-condition.mjs';
import { artifactPath, temporaryPath } from '../../scripts/workspace-paths.mjs';

const workspace = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const output = process.env.TRYLO_NATIVE_HEADLESS_OUTPUT ? path.resolve(process.env.TRYLO_NATIVE_HEADLESS_OUTPUT) : artifactPath('desktop-native-browser-headless');
const tempRoot = temporaryPath('desktop-native-browser-headless');
await fs.mkdir(tempRoot, { recursive: true });
const profile = await fs.mkdtemp(path.join(tempRoot, 'trylo-native-headless-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = probePlaywrightChromium();
let child, browser, service, site, client;
const proof = { kind: 'headless MCP acceptance; not native WebView2', nativeVerified: false, checks: [] };
const sources = ['desktop-services/src/host.mjs', 'desktop-services/src/tooling/native-browser-service.mjs', 'desktop-services/src/tooling/native-browser-mcp.mjs', 'desktop-services/src/tooling/tool-profile-service.mjs', 'desktop/src-tauri/src/commands/native_browser.rs', 'desktop/src-tauri/src/lib.rs', 'desktop/src/tooling/use-browser-preview.ts', 'desktop/src/components/chat/BrowserToolSidebar.tsx'];
async function hashes() { return Object.fromEntries(await Promise.all(sources.map(async file => [file, crypto.createHash('sha256').update(await fs.readFile(path.join(workspace, file))).digest('hex')]))); }
proof.sourcesBefore = await hashes();
if (process.env.TRYLO_NATIVE_HOST_ENTRY) proof.bundle = { path: process.env.TRYLO_NATIVE_HOST_ENTRY, sha256: crypto.createHash('sha256').update(await fs.readFile(process.env.TRYLO_NATIVE_HOST_ENTRY)).digest('hex') };
async function socket(url) {
  const ws = new WebSocket(url), pending = new Map(); let next = 0;
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('socket timeout')), 5000); ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const message = JSON.parse(String(event.data)); const call = pending.get(message.id); if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); } });
  return { ws, send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 10000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }); } };
}
async function mcp(gate, endpoint) {
  const entry = path.join(workspace, 'desktop-services/toolchain/browser/playwright-mcp/cli.js');
  const processHandle = spawn(process.execPath, [process.env.TRYLO_NATIVE_HOST_ENTRY || path.join(workspace, 'desktop-services/src/host.mjs'), '--native-browser-mcp', gate, entry, '--cdp-endpoint', endpoint], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: profile });
  const pending = new Map(); let next = 0, diagnostic = '';
  processHandle.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-5000); });
  readline.createInterface({ input: processHandle.stdout }).on('line', line => { const result = JSON.parse(line); const call = pending.get(result.id); if (call) { clearTimeout(call.timer); pending.delete(result.id); result.error ? call.reject(new Error(result.error.message)) : call.resolve(result.result); } });
  const request = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout: ${diagnostic}`)); }, 30000); pending.set(id, { resolve, reject, timer }); processHandle.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-headless-acceptance', version: '1' } });
  processHandle.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return { processHandle, initialized, request, async tool(name, args) { const result = await request('tools/call', { name, arguments: args }); if (result.isError) throw new Error(JSON.stringify(result)); return result; } };
}
function check(name, actual, expected = true) {
  if (actual !== expected) throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  proof.checks.push({ name, result: 'pass' });
}
try {
  if (!probe.ok) throw new Error(probe.detail);
  child = spawn(path.join(probe.root, probe.build, 'chrome-win64/chrome.exe'), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let portInfo;
  for (let index = 0; index < 100; index++) { try { portInfo = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; } catch { await delay(100); } }
  if (!portInfo) throw new Error('headless engine did not start');
  const cdpPort = Number(portInfo[0]); browser = await socket(`ws://127.0.0.1:${cdpPort}${portInfo[1]}`);
  proof.browser = await browser.send('Browser.getVersion');
  const list = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).filter(page => page.type === 'page');
  let first;
  for (let index = 0; index < 100; index++) { first = (await list())[0]; if (first) break; await delay(50); }
  if (!first) throw new Error('headless fixture initial page did not appear');
  const tabs = [{ id: first.id, label: 'headless-view-1', marker: 'about:blank#trylo-native-headless-view-1' }];
  let activeLabel = tabs[0].label, counter = 1;
  const scope = nativeBrowserScope({ projectRoot: workspace, conversationId: 'headless-native' });
  const record = () => ({ scope, cdpPort, tabs: tabs.map(({ label, marker }) => ({ label, marker })), activeLabel });
  async function pageCommand(id, method, params) { const page = (await list()).find(item => item.id === id); if (!page) throw new Error('missing headless fixture page'); const connection = await socket(page.webSocketDebuggerUrl); try { return await connection.send(method, params); } finally { connection.ws.close(); } }
  await pageCommand(first.id, 'Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(globalThis,'__tryloNativeView',{value:${JSON.stringify(tabs[0].label)}});` });
  await pageCommand(first.id, 'Page.navigate', { url: tabs[0].marker });
  service = createNativeBrowserService({ requestNative: async (key, operation, params = {}) => {
    check('scope remains bound', key, scope);
    if (operation === 'create') {
      const label = `headless-view-${++counter}`, marker = `about:blank#trylo-native-${label}`;
      const created = await browser.send('Target.createTarget', { url: marker }); tabs.push({ id: created.targetId, label, marker }); activeLabel = label;
    } else if (operation === 'activate') { activeLabel = params.label; }
    else if (operation === 'close') {
      const index = tabs.findIndex(tab => tab.label === params.label); await browser.send('Target.closeTarget', { targetId: tabs[index].id }); tabs.splice(index, 1); activeLabel = tabs[0].label;
    }
    return record();
  } });
  const registration = await service.register({ projectRoot: workspace, conversationId: 'headless-native', record: record() });
  site = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html><head><title>Native acceptance fixture</title><style>body{margin:0;font:16px sans-serif}button,input{display:block;width:240px;height:50px;margin:30px}a{color:#286597}.error{color:#bc414a}#spacer{height:2000px}</style></head><body><label>查询词<input aria-label="查询词"></label><button onclick="window.clicks=(window.clicks||0)+1">点我</button><a href="/after">蓝色链接</a><p class="error">红色错误文字</p><div id="spacer"></div></body></html>'); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}/first`;
  client = await mcp(registration.endpoint, registration.endpoint + '/'); proof.mcp = client.initialized.serverInfo;
  await client.tool('browser_navigate', { url });
  const snap = await client.tool('browser_snapshot', {});
  const text = snap.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const inputRef = /textbox "查询词" \[ref=([^\]]+)\]/.exec(text)?.[1];
  const buttonRef = /button "点我" \[ref=([^\]]+)\]/.exec(text)?.[1];
  if (!inputRef || !buttonRef) throw new Error(`real snapshot refs missing: ${text}`);
  await client.tool('browser_type', { element: '查询词', target: inputRef, text: '真实中文输入' });
  await client.tool('browser_click', { element: '点我', target: buttonRef });
  const content = await pageCommand(first.id, 'Runtime.evaluate', { expression: 'JSON.stringify({clicks:window.clicks,text:document.querySelector("input").value})', returnByValue: true });
  const result = JSON.parse(content.result.value);
  check('real MCP click reaches the displayed target', result.clicks, 1);
  check('real MCP enters CJK text', result.text, '真实中文输入');
  await pageCommand(first.id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 350, deltaX: 0, deltaY: 500 }); await delay(150);
  check('browser engine scroll moves down', (await pageCommand(first.id, 'Runtime.evaluate', { expression: 'scrollY > 0', returnByValue: true })).result.value);
  const active = client.tool('browser_evaluate', { function: '() => new Promise(resolve => setTimeout(() => resolve(document.title), 600))' });
  const until = Date.now() + 5000; while (!(await service.snapshot({ scope })).inFlight && Date.now() < until) await delay(20);
  check('takeover waits for an active complete tool', (await service.control({ scope, heldByUser: true })).control, 'pending');
  let nextFinished = false; const queued = client.tool('browser_navigate', { url: url.replace('/first', '/after') }).then(result => { nextFinished = true; return result; });
  await active; await delay(100);
  check('takeover is confirmed only after active tool completion', (await service.snapshot({ scope })).control, 'user');
  check('queued real MCP navigation stays blocked', nextFinished, false);
  check('held page URL remains unchanged', (await list()).find(page => page.id === first.id).url, url);
  await service.control({ scope, heldByUser: false }); await queued;
  check('handoff resumes the waiting real MCP request', (await list()).find(page => page.id === first.id).url.endsWith('/after'));
  await client.tool('browser_tabs', { action: 'new' });
  check('MCP tab creation goes through the native host interface', tabs.length, 2);
  check('MCP selected target matches the hosted view', (await service.snapshot({ scope })).activeLabel, activeLabel);
  const selectedByMcp = activeLabel;
  await service.select({ scope, label: tabs[0].label });
  await client.tool('browser_evaluate', { function: '() => document.title' });
  check('preview follows the actual MCP page after the user selects another native tab', (await service.snapshot({ scope })).activeLabel, selectedByMcp);
  client.processHandle.stdin.end(); await Promise.race([new Promise(resolve => client.processHandle.once('exit', resolve)), delay(5000)]);
  check('MCP wrapper actually exits on stdin close', client.processHandle.exitCode !== null);
  check('native-owned engine survives MCP process shutdown', (await list()).length, 2);
  proof.result = 'pass';
} catch (error) { proof.result = 'fail'; proof.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  client?.processHandle.kill(); await service?.dispose();
  if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
  if (browser) { await browser.send('Browser.close').catch(() => {}); browser.ws.close(); }
  if (child?.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2500)]); if (child.exitCode === null) child.kill(); }
  proof.sourcesAfter = await hashes(); proof.sourceStable = JSON.stringify(proof.sourcesBefore) === JSON.stringify(proof.sourcesAfter);
  if (!proof.sourceStable) { proof.result = 'fail'; proof.error = 'production source changed during acceptance'; process.exitCode = 1; }
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, process.env.TRYLO_NATIVE_HOST_ENTRY ? 'headless-bundled-mcp-proof.json' : 'headless-mcp-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  const resolved = path.resolve(profile); if (resolved.startsWith(tempRoot + path.sep) && path.basename(resolved).startsWith('trylo-native-headless-')) await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ result: proof.result, checks: proof.checks.length, output: path.join(output, process.env.TRYLO_NATIVE_HOST_ENTRY ? 'headless-bundled-mcp-proof.json' : 'headless-mcp-proof.json'), error: proof.error }));
}
