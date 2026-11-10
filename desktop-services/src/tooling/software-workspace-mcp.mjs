import readline from 'node:readline';
import crypto from 'node:crypto';
import { SOFTWARE_TOOLS, SOFTWARE_VERSION } from './software-workspace-contract.mjs';

/** Thin MCP transport. Existing CLI classification and approval remain owners. */
export async function runSoftwareWorkspaceMcp({ gate, packageId, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(gate ?? '')) throw new Error('software_invalid_gate');
  const input = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  const running = new Map();
  const clientId = crypto.randomUUID();
  let closed = false;
  const write = value => { if (!closed) stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); };
  async function handle(message) {
    if (!message || typeof message !== 'object') return;
    const notification = message.id === undefined;
    if (!packageId) {
      if (message.method === 'notifications/cancelled') { running.get(message.params?.requestId)?.abort(); return; }
      if (notification) return;
      if (message.method === 'initialize') return write({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'trylo-software', version: SOFTWARE_VERSION } } });
      if (message.method === 'ping') return write({ id: message.id, result: {} });
      if (message.method === 'tools/list') return write({ id: message.id, result: { tools: SOFTWARE_TOOLS } });
      if (message.method !== 'tools/call') return write({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
    const controller = new AbortController();
    if (!notification && running.has(message.id)) return write({ id: message.id, error: { code: -32600, message: 'Duplicate active request id' } });
    if (!notification) running.set(message.id, controller);
    try {
      const tool = packageId ? undefined : SOFTWARE_TOOLS.find(tool => tool.name === message.params?.name);
      if (!packageId && !tool) throw new Error('software_unknown_tool');
      const response = await fetch(`${gate}/${packageId ? 'api' : 'call'}`, { method: 'POST', signal: controller.signal,
        body: JSON.stringify(packageId ? { packageId, clientId, pid: process.pid, message } : { operation: tool.name.slice(9), input: message.params.arguments ?? {} }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'software_call_failed');
      if (notification) return;
      if (packageId) return write(softwareApiResult(packageId, message, result));
      const { data, ...metadata } = result;
      const content = [{ type: 'text', text: JSON.stringify(metadata) }];
      if (data) content.push({ type: 'image', mimeType: result.mimeType, data });
      write({ id: message.id, result: { content, isError: false } });
    } catch (error) {
      if (!notification) write({ id: message.id, result: { content: [{ type: 'text', text: String(error.message ?? error) }], isError: true } });
    } finally { if (!notification) running.delete(message.id); }
  }
  input.on('line', line => { try { void handle(JSON.parse(line)); } catch { /* Invalid JSON is not an executable call. */ } });
  input.once('close', () => {
    closed = true;
    for (const controller of running.values()) controller.abort();
    running.clear();
    if (packageId) void fetch(`${gate}/api`, { method: 'POST', body: JSON.stringify({ packageId, clientId,
      message: { method: 'trylo/clientClosed' } }) }).catch(() => {});
  });
}

export function softwareApiResult(packageId, request, response) {
  // The pinned SW server reports business errors as JSON inside text while
  // leaving MCP isError=false. Preserve the body, correct only that receipt.
  if (packageId !== 'solidworks-mcp' || request.method !== 'tools/call' || !response.result) return response;
  const value = response.result.structuredContent?.result ?? response.result.content?.find(item => item.type === 'text')?.text;
  try {
    if (JSON.parse(value).status === 'error') return { ...response, result: { ...response.result, isError: true } };
  } catch { /* Non-JSON tool content retains its original MCP disposition. */ }
  return response;
}
