// Thin stdio relay: the upstream MCP retains all tool semantics. The lease
// covers the complete tools/call, including locator retries and mouse release.
import readline from 'node:readline';
import { spawn } from 'node:child_process';

export function nativeBrowserMcpArgs(gate, args) {
  const expected = `${gate.replace('http:', 'ws:')}/cdp/browser`;
  const output = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg !== '--browserUrl' && !arg.startsWith('--browserUrl=')) { output.push(arg); continue; }
    const value = arg === '--browserUrl' ? args[++index] : arg.slice('--browserUrl='.length);
    if (value !== gate && value !== `${gate}/`) throw new Error('native browser endpoint does not match its session');
    // Compatibility for profiles produced by an already-running Service Host.
    output.push('--wsEndpoint', expected);
  }
  return output;
}

export async function runNativeBrowserMcp({ gate, entry, args = [], stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, spawnProcess = spawn } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+$/.test(gate) || !entry) throw new Error('invalid native browser MCP bridge');
  const childArgs = nativeBrowserMcpArgs(gate, args);
  const abort = new AbortController();
  const post = async (route, value, signal = abort.signal) => {
    const response = await fetch(`${gate}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`); return result;
  };
  const { clientId } = await post('client/open', { pid: process.pid });
  const child = spawnProcess(process.execPath, [entry, ...childArgs], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const leases = new Map(), waiting = new Map();
  let disposed = false, outputTail = Promise.resolve();
  const writeError = (id, error) => stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error.message ?? error) } }) + '\n');
  const input = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.pipe(stderr, { end: false });
  async function stop() {
    if (disposed) return; disposed = true; abort.abort();
    for (const controller of waiting.values()) controller.abort();
    child.stdin.end(); child.kill(); input.close(); output.close();
    await post('client/close', { clientId }, AbortSignal.timeout(3000)).catch(() => {});
  }
  input.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'notifications/cancelled') {
      waiting.get(message.params?.requestId)?.abort();
      child.stdin.write(line + '\n'); return;
    }
    if (message.method !== 'tools/call') { child.stdin.write(line + '\n'); return; }
    const controller = new AbortController(); waiting.set(message.id, controller);
    void post('lease/start', { clientId }, controller.signal).then(async ({ leaseId }) => {
      waiting.delete(message.id);
      if (disposed || controller.signal.aborted) { void post('lease/end', { clientId, leaseId }).catch(() => {}); return; }
      leases.set(message.id, leaseId);
      const call = message.params;
      if ((call?.name === 'browser_navigate' || (call?.name === 'browser_tabs' && call.arguments?.action === 'new'))
        && typeof call.arguments?.url === 'string' && call.arguments.url.toLowerCase().startsWith('file:')) {
        const preview = await post('preview/resolve', { clientId, leaseId, url: call.arguments.url }, controller.signal);
        message.params = { ...call, arguments: { ...call.arguments, url: preview.url } };
        line = JSON.stringify(message);
      }
      if (disposed || controller.signal.aborted) {
        leases.delete(message.id); await post('lease/end', { clientId, leaseId }).catch(() => {}); return;
      }
      child.stdin.write(line + '\n');
    }).catch(error => {
      waiting.delete(message.id);
      const leaseId = leases.get(message.id);
      if (leaseId) { leases.delete(message.id); void post('lease/end', { clientId, leaseId }).catch(() => {}); }
      if (!disposed) writeError(message.id, error);
    });
  });
  output.on('line', line => {
    outputTail = outputTail.then(async () => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const leaseId = leases.get(message.id);
      if (leaseId) { leases.delete(message.id); await post('lease/end', { clientId, leaseId }).catch(() => {}); }
      if (!disposed) stdout.write(line + '\n');
    });
  });
  input.once('close', () => { void stop(); }); child.once('error', () => { void stop(); }); child.once('exit', () => { void stop(); });
  child.stdin.on('error', () => { void stop(); });
  return { stop, child };
}
