// Real headless Chromium/CDP verification. Never launches Trylo or a desktop window.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createNativeBrowserService, nativeBrowserScope } from '../src/tooling/browser/native-browser-service.mjs';
import { artifactPath } from '../../scripts/workspace-paths.mjs';

const workspace = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const output = artifactPath('desktop-native-browser-cursor');
const { chromium } = createRequire(path.join(workspace, 'desktop-services/toolchain/browser/playwright-mcp/package.json'))('playwright');
const proof = { kind: 'headless Chromium with real CDP input and isolated cursor overlay', nativeVerified: false, checks: [], images: [] };
const check = name => proof.checks.push({ name, result: 'pass' });
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const cdpPort = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const site = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Security-Policy', "require-trusted-types-for 'script'; trusted-types 'none'");
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>光标无头验收</title><style>body{margin:0;background:#fff;color:#262725;font:14px/1.6 system-ui}main{padding:32px}h1{font-size:21px;margin:0 0 6px}p{color:#71736e}label{display:block;margin:24px 0 6px}input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font:inherit}button{display:block;margin:16px 0;padding:9px 28px;border:1px solid #71736e;border-radius:6px;background:#faf8f3;font:inherit;color:#262725}a{color:#286597}.error{color:#bc414a}output{display:block}</style><main><h1>资料表单</h1><p>独立无头测试页面</p><a href="#help">查看说明</a><label for="name">姓名</label><input id="name" value="Trylo"><button id="save" onclick="document.querySelector('output').textContent='已保存'">保存</button><output></output><p class="error">错误提示颜色保持原样</p></main></html>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
let browser;
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let id = 0;
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', raw => { const message = JSON.parse(String(raw)); const call = pending.get(message.id); if (!call) return; pending.delete(message.id); clearTimeout(call.timer); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); });
  return { close: () => ws.terminate(), request(method, params = {}) { return new Promise((resolve, reject) => { const next = ++id, timer = setTimeout(() => reject(new Error(`${method} timeout`)), 3000); pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params })); }); } };
}
function cursorNode(node) {
  if (node.attributes?.some((attribute, index) => attribute === 'class' && node.attributes[index + 1] === 'cursor')) return node;
  for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) { const found = cursorNode(child); if (found) return found; }
}
await fs.mkdir(output, { recursive: true });
try {
  browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 480, height: 640 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${site.address().port}/?dpr=${dpr}`);
    const enginePages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const target = enginePages.find(entry => entry.url === page.url()); assert.ok(target);
    const scope = nativeBrowserScope({ projectRoot: workspace, conversationId: 'cursor-headless' });
    const record = { scope, cdpPort, tabs: [{ label: 'headless-native', marker: page.url() }], activeLabel: 'headless-native' };
    const service = createNativeBrowserService({ requestNative: async () => record });
    let client;
    try {
      const registration = await service.register({ projectRoot: workspace, conversationId: 'cursor-headless', record });
      const post = async (route, params) => (await fetch(`${registration.endpoint}/${route}`, { method: 'POST', body: JSON.stringify(params) })).json();
      const { clientId } = await post('client/open', { pid: process.pid });
      const { leaseId } = await post('lease/start', { clientId });
      const list = await (await fetch(`${registration.endpoint}/json/list`)).json();
      client = await connect(list.find(entry => entry.id === target.id).webSocketDebuggerUrl);
      const box = await page.locator('#save').boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await client.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await page.locator('[data-trylo-agent-cursor]').waitFor({ state: 'attached' });
      let node;
      for (let i = 0; i < 30 && !node; i++) { node = cursorNode((await client.request('DOM.getDocument', { depth: -1, pierce: true })).root); if (!node) await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.ok(node);
      const model = (await client.request('DOM.getBoxModel', { nodeId: node.nodeId })).model;
      assert.ok(Math.abs(model.content[0] - point.x) < .5 && Math.abs(model.content[1] - point.y) < .5);
      check(`DPR ${dpr}: cursor painted at actual CDP CSS coordinates`);
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, point), 'save');
      assert.equal(await page.evaluate(() => document.querySelector('[data-trylo-agent-cursor]').shadowRoot), null);
      assert.equal(await page.evaluate(() => typeof globalThis.__tryloAgentCursorUpdate), 'undefined');
      check(`DPR ${dpr}: overlay does not capture input or expose its world`);
      assert.equal(await page.evaluate(() => {
        try { document.createElement('div').innerHTML = '<span></span>'; return false; } catch { return true; }
      }), true);
      check(`DPR ${dpr}: overlay renders while Trusted Types rejects HTML sinks`);
      await client.request('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await client.request('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      assert.equal(await page.locator('output').textContent(), '已保存');
      check(`DPR ${dpr}: actual click reaches the original page`);
      const image = `agent-cursor-dpr-${dpr}.png`; await page.screenshot({ path: path.join(output, image) }); proof.images.push(image);
      assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.querySelector('a')).color, getComputedStyle(document.querySelector('.error')).color]), ['rgb(40, 101, 151)', 'rgb(188, 65, 74)']);
      check(`DPR ${dpr}: native page link and error colors preserved`);
      await service.control({ scope, heldByUser: true });
      await post('lease/end', { clientId, leaseId });
      await page.locator('[data-trylo-agent-cursor]').waitFor({ state: 'detached' });
      check(`DPR ${dpr}: confirmed takeover clears the agent cursor`);
    } finally { client?.close(); await service.dispose(); await context.close(); }
  }
  proof.result = 'pass';
} catch (error) { proof.result = 'fail'; proof.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  await browser?.close(); site.closeAllConnections(); await new Promise(resolve => site.close(resolve));
  await fs.writeFile(path.join(output, 'cursor-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
}
