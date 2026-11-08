import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import crypto from 'node:crypto';
import http from 'node:http';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(repo, '_workspace/artifacts/output/amd-dual-pool-desktop-20261025');
const toolProbe = process.argv.includes('--tool'), suffix = toolProbe ? '-tool' : '', marker = toolProbe ? 'TRYLO_TOOL_OK_2417' : 'TRYLO_PLATFORM_OK';
const resources = path.join(repo, 'desktop/src-tauri/resources');
const source = path.join(process.env.APPDATA, 'me.trylocode.trylo/Trylo/remote/relay-session.json');
const original = await fs.readFile(source), session = JSON.parse(original);
if (session.serverUrl !== 'https://relay.trylocode.me' || session.username.toLowerCase() !== 'ylz' || session.expiresAt - Date.now() < 86400000) throw Error('Existing owner session required; do not renew or alter it during this probe');
const privateRoot = 'D:/CC/trylo-deploy-credentials/seoul/desktop-platform-probe-' + Date.now();
await fs.mkdir(privateRoot);
if (process.platform === 'win32') execFileSync('icacls', [privateRoot, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true });
const clone = path.join(privateRoot, 'Trylo/remote/relay-session.json');
await fs.mkdir(path.dirname(clone), { recursive: true }); await fs.writeFile(clone, original, { mode: 0o600 });
const nodeProgram = path.join(resources, 'runtime/node/win-x64/node.exe');
const hostEntry = path.join(resources, 'desktop-services/dist/host.bundle.mjs');
const child = spawn(nodeProgram, [hostEntry], { cwd: resources, env: { ...process.env, TRYLO_APP_DATA_DIR: privateRoot, TRYLO_SIDECARS_DIR: path.join(resources, 'sidecars') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map(); let sequence = 0, readyResolve, readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
const lines = createInterface({ input: child.stdout }); child.stderr.resume();
lines.on('line', line => { let frame; try { frame = JSON.parse(line); } catch { return; } if (frame.topic === 'ready') readyResolve(); if (frame.type === 'response') { const request = pending.get(frame.id); if (!request) return; pending.delete(frame.id); clearTimeout(request.timer); if (frame.ok) request.resolve(frame.result); else request.reject(Error(frame.error?.message || 'Service Host refused model call')); } });
child.on('error', readyReject);
function request(method, params) { return new Promise((resolve, reject) => { const id = String(++sequence), timer = setTimeout(() => { pending.delete(id); reject(Error('Service Host model RPC timed out')); }, 30000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ version: 1, type: 'request', id, method, params }) + '\n'); }); }
let connection, diagnostic;
try {
  await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Service Host startup timed out')), 20000); timer.unref(); })]);
  const catalog = await request('remote.relayModels');
  if (catalog.models.length !== 10 || catalog.models.some(item => item.chat !== true)) throw Error('Expected 10 account-authorized text models');
  connection = await request('remote.relayModelConnection', { model: 'Qwen3.8-Flash-Next' });
  if (!connection.apiHost.startsWith('http://127.0.0.1:') || connection.apiKey === session.accessToken) throw Error('Invalid account isolation');
  const workspace = path.join(output, 'live-cli-workspace'), home = path.join(output, 'live-cli-home');
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(home, { recursive: true });
  const entry = path.join(resources, 'cli/dist/cmd/trylo/main.js');
  let endpoint = connection.apiHost + '/chat/completions';
  if (process.argv.includes('--diagnostic')) {
    diagnostic = http.createServer(async (request, response) => {
      const chunks=[]; for await(const chunk of request) chunks.push(chunk); const body=Buffer.concat(chunks);
      await fs.writeFile(path.join(output,'live-cli-synthetic-payload.json'),body);
      const result=await fetch(connection.apiHost+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.apiKey},body});
      response.writeHead(result.status,{'Content-Type':result.headers.get('content-type')||'application/json'});
      const reply=[];for await(const chunk of result.body){reply.push(chunk);response.write(chunk);}response.end();
      if(!result.ok)await fs.writeFile(path.join(output,'live-cli-rejection.json'),Buffer.concat(reply));
    });
    diagnostic.listen(0,'127.0.0.1');await once(diagnostic,'listening');endpoint=`http://127.0.0.1:${diagnostic.address().port}/v1/chat/completions`;
  }
  if (toolProbe) await fs.writeFile(path.join(workspace, 'platform-probe.txt'), marker + '\n');
  const argv = [entry, 'run', '--format', 'stream-json', '--workspace', workspace, '--provider', 'openai-compatible', '--endpoint', endpoint, '--model', connection.apiModel, '--max-tokens', '512', '--max-iterations', '3', '-'];
  const cli = spawn(nodeProgram, argv, { cwd: workspace, env: { ...process.env, TRYLO_HOME: home, TRYLO_OPENAI_API_KEY: connection.apiKey }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdout = [], stderr = []; cli.stdout.on('data', chunk => stdout.push(chunk)); cli.stderr.on('data', chunk => stderr.push(chunk));
  const timer = setTimeout(() => cli.kill(), 125000);
  const prompt = toolProbe ? 'Use read_file to read platform-probe.txt from the workspace. Reply with only the exact text in that file. Do not use any other tool.' : 'Reply with only TRYLO_PLATFORM_OK. Do not use any tools.';
  cli.stdin.end(JSON.stringify({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null }) + '\n');
  const [exitCode] = await once(cli, 'exit'); clearTimeout(timer);
  const redact = text => text.replaceAll(session.accessToken, '[account-redacted]').replaceAll(connection.apiKey, '[local-capability-redacted]');
  const wire = redact(Buffer.concat(stdout).toString('utf8'));
  await fs.writeFile(path.join(output, 'live-cli-events'+suffix+'.ndjson'), wire); await fs.writeFile(path.join(output, 'live-cli-stderr'+suffix+'.txt'), redact(Buffer.concat(stderr).toString('utf8')));
  const frames = wire.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const terminal=frames.filter(frame => ['run_result', 'run_finish', 'error'].includes(frame.type));
  const result = { at: new Date().toISOString(), realProvider: true, nativeRenderer: false, packagedInstaller: false, serviceHostRpc: true, sourceSessionUnchanged: original.equals(await fs.readFile(source)), desktopModels: catalog.models.map(model => model.id), specialistsExcluded: true, ephemeralLoopbackCredential: true, stagedNode: nodeProgram, stagedCli: entry, serviceHostSha256: crypto.createHash('sha256').update(await fs.readFile(hostEntry)).digest('hex'), cliSha256: crypto.createHash('sha256').update(await fs.readFile(entry)).digest('hex'), exitCode, eventTypes: [...new Set(frames.map(frame => frame.type))], outputContainsMarker: terminal.some(frame=>frame.status==='completed'&&frame.lastMessage?.includes(marker)), toolProbe, readToolCalled: toolProbe ? wire.includes('read_file') : undefined, terminal };
  await fs.writeFile(path.join(output, 'live-desktop-chain'+suffix+'.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (exitCode !== 0 || !result.outputContainsMarker || !result.sourceSessionUnchanged || toolProbe && !result.readToolCalled) throw Error('Live platform CLI acceptance failed; inspect retained evidence');
} finally {
  if(diagnostic){diagnostic.closeAllConnections();await new Promise(resolve=>diagnostic.close(resolve));}
  child.stdin.end(); const stopped = once(child, 'exit'); const timer = setTimeout(() => child.kill(), 5000); await stopped.catch(() => {}); clearTimeout(timer);
  for (const request of pending.values()) clearTimeout(request.timer);
  // Remove the copied native session, retaining only non-secret run artifacts.
  if (path.resolve(clone).startsWith(path.resolve('D:/CC/trylo-deploy-credentials/seoul') + path.sep)) await fs.rm(clone, { force: true });
}
