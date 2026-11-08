// Headless shell/layout acceptance. Does not launch Trylo or inspect the desktop.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import { artifactPath } from '../../scripts/workspace-paths.mjs';
const desktop = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = process.env.TRYLO_NATIVE_UI_OUTPUT ? path.resolve(process.env.TRYLO_NATIVE_UI_OUTPUT) : artifactPath('desktop-native-browser-acceptance');
const require = createRequire(path.join(desktop, '../desktop-services/toolchain/browser/playwright-mcp/package.json'));
const { chromium } = require('playwright');
const { build } = createRequire(path.join(desktop, '../desktop-services/package.json'))('esbuild');
const assets = path.join(output, 'headless-ui-assets');
await build({ entryPoints: [path.join(desktop, 'testdata/native-browser-acceptance/fixture.tsx')],
  outfile: path.join(assets, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'file', '.png': 'file', '.ttf': 'file' },
  plugins: [{ name: 'unused-lazy-previews', setup(builder) { builder.onResolve({ filter: /.*/ }, args => args.kind === 'dynamic-import' ? { path: args.path, external: true } : undefined); } }],
});
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); return; }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { response.writeHead(404).end(); return; }
  try { response.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'application/octet-stream'); response.end(await fs.readFile(path.join(assets, name))); } catch { response.writeHead(404).end(); }
});
let browser;
const proof = { kind: 'headless real AppShell/InputBar; native surface not rendered', nativeVerified: false, checks: [], images: [] };
await fs.mkdir(output, { recursive: true });
const check = (name, details) => proof.checks.push({ name, result: 'pass', details });
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => { proof.checks.push({ name: 'page error', result: 'fail', error: String(error) }); });
  page.on('console', message => { if (message.type() === 'error') (proof.diagnostics ??= []).push(message.text()); });
  page.on('requestfailed', request => { (proof.diagnostics ??= []).push(`${request.url()}: ${request.failure()?.errorText}`); });
  const load = async phase => {
    await page.goto(`${base}?phase=${phase}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await page.locator('.app-shell').waitFor({ timeout: 120000 });
    if (!(await page.locator('.browser-tool-sidebar').count())) await page.getByRole('button', { name: '浏览器侧栏', exact: true }).click();
    await page.locator('.browser-tool-sidebar').waitFor();
  };
  const layout = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.evaluate(() => {
      const rect = selector => { const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height, right, bottom }; };
      return { sidebar: rect('.browser-tool-sidebar'), main: rect('.app-shell__main'), input: rect('textarea'), native: rect('.browser-tool-sidebar__picture'), reported: window.__nativeBounds, viewport: { width: innerWidth, height: innerHeight } };
    });
    assert.ok(bounds.sidebar.right <= bounds.viewport.width + 1); assert.ok(bounds.input.width > 200);
    assert.ok(bounds.input.bottom <= bounds.viewport.height + 1); assert.ok(bounds.main.width >= 360);
    assert.ok(bounds.native.height > 100);
    if (bounds.reported?.visible) assert.equal(bounds.reported.width, bounds.native.width);
    check(name, bounds); return bounds;
  };
  for (const [phase, label] of Object.entries({ idle: '空闲', connecting: '连接中', executing: '执行中', done: '已完成', disconnected: '预览断连', failed: '工具失败', stopped: '任务停止' })) {
    await load(phase); assert.equal(await page.locator('.browser-tool-sidebar').getAttribute('data-phase'), phase);
    assert.equal(await page.locator('.browser-tool-sidebar__phase').innerText(), label);
    if (phase === 'failed') assert.ok(await page.getByRole('alert').filter({ hasText: '未找到“查询”按钮' }).isVisible());
    await layout(`1280x800 ${phase}`);
    const image = `${phase}-1280x800.png`; await page.screenshot({ path: path.join(output, image) }); proof.images.push(image);
  }
  await load('executing'); await page.getByRole('button', { name: '我接管', exact: true }).click();
  await page.getByText('你已接管', { exact: true }).waitFor(); check('takeover control is visible');
  await page.getByRole('button', { name: '交回智能体', exact: true }).click(); await page.getByText('智能体操作', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1048, height: 900 }); await layout('1048x900');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('继续检查网页');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), '继续检查网页');
  check('1048x900 real chat composer accepts text');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
  await page.screenshot({ path: path.join(output, 'executing-1048x900.png') }); proof.images.push('executing-1048x900.png');
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => document.querySelector('.browser-tool-sidebar').getBoundingClientRect().left >= 1000);
  const splitter = await page.getByRole('separator', { name: 'Resize file panel' }).boundingBox();
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 150); await page.mouse.down();
  await page.mouse.move(215, splitter.y + 150, { steps: 8 }); await page.mouse.up();
  const wide = await layout('sidebar grows past old 760px cap'); assert.ok(wide.sidebar.width > 760);
  await page.getByRole('button', { name: '浏览器全屏', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.browser-tool-sidebar').getBoundingClientRect().width > 1500);
  assert.equal(await page.locator('.browser-tool-sidebar').getAttribute('data-fullscreen'), 'true');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const fullscreen = await page.evaluate(() => ({ width: document.querySelector('.browser-tool-sidebar').getBoundingClientRect().width,
    controls: [...document.querySelectorAll('.browser-tool-sidebar button')].map(button => ({ label: button.getAttribute('aria-label'), right: button.getBoundingClientRect().right })), reported: window.__nativeBounds }));
  assert.equal(fullscreen.width, 1600); assert.ok(fullscreen.controls.every(button => button.right <= 1600));
  check('fullscreen covers the window and keeps controls in bounds', fullscreen);
  await page.screenshot({ path: path.join(output, 'fullscreen-1600x900.png') }); proof.images.push('fullscreen-1600x900.png');
  await page.getByRole('button', { name: '退出浏览器全屏', exact: true }).click();
  const restored = await layout('fullscreen restores dragged width'); assert.equal(Math.round(restored.sidebar.width), Math.round(wide.sidebar.width));
  const divider = await page.getByRole('separator', { name: 'Resize file panel' }).boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 150); await page.mouse.down();
  await page.mouse.move(1590, divider.y + 150, { steps: 8 }); await page.mouse.up();
  const minimum = await layout('320px minimum sidebar'); assert.equal(Math.round(minimum.sidebar.width), 320);
  await page.screenshot({ path: path.join(output, 'minimum-320px.png') }); proof.images.push('minimum-320px.png');
  const highDpi = await browser.newPage({ viewport: { width: 1048, height: 900 }, deviceScaleFactor: 2 });
  await highDpi.goto(`${base}?phase=executing`); await highDpi.locator('.browser-tool-sidebar').waitFor();
  await highDpi.waitForFunction(() => window.__nativeBounds?.visible);
  const geometry = await highDpi.evaluate(() => ({ dpr: devicePixelRatio, expected: document.querySelector('.browser-tool-sidebar__picture').getBoundingClientRect().width, actual: window.__nativeBounds.width }));
  assert.equal(geometry.dpr, 2); assert.equal(geometry.actual, geometry.expected); check('DPR2 reports logical native bounds without doubling viewport', geometry);
  assert.ok(!proof.checks.some(check => check.result === 'fail'));
  proof.result = 'pass';
} catch (error) { proof.result = 'fail'; proof.error = String(error.stack ?? error); process.exitCode = 1; }
finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.writeFile(path.join(output, 'headless-ui-proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ result: proof.result, checks: proof.checks.length, error: proof.error, output })); }
