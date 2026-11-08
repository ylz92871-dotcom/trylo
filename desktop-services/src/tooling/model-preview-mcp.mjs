import readline from 'node:readline';
import { MODEL_PREVIEW_TOOLS, MODEL_PREVIEW_VERSION } from './model-preview-contract.mjs';

/** Thin stdio client of a scope-bound Service Host gate; never reads files. */
export async function runModelPreviewMcp({ gate, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+$/.test(gate ?? '')) throw new Error('model_preview_invalid_gate');
  const input = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  const running = new Map();
  let closed = false;
  const write = message => { if (!closed) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.method === 'notifications/cancelled') { running.get(message.params?.requestId)?.abort(); return; }
    if (message.id === undefined) return;
    if (message.method === 'initialize') return write({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'trylo-preview', version: MODEL_PREVIEW_VERSION } } });
    if (message.method === 'ping') return write({ id: message.id, result: {} });
    if (message.method === 'tools/list') return write({ id: message.id, result: { tools: MODEL_PREVIEW_TOOLS } });
    if (message.method !== 'tools/call') return write({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    const controller = new AbortController();
    if (running.has(message.id)) return write({ id: message.id, error: { code: -32600, message: 'Duplicate active request id' } });
    running.set(message.id, controller);
    try {
      const tool = MODEL_PREVIEW_TOOLS.find(tool => tool.name === message.params?.name);
      if (!tool) throw new Error('model_preview_unknown_tool');
      const response = await fetch(`${gate}/call`, { method: 'POST', body: JSON.stringify({ operation: tool.name.slice('preview_'.length), input: message.params.arguments ?? {} }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'model_preview_failed');
      const { dataUrl, ...metadata } = result;
      const content = [{ type: 'text', text: JSON.stringify(metadata) }];
      if (dataUrl) content.push({ type: 'image', mimeType: result.mimeType, data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
      write({ id: message.id, result: { content, isError: false } });
    } catch (error) {
      write({ id: message.id, result: { content: [{ type: 'text', text: controller.signal.aborted ? 'model_preview_cancelled' : String(error.message ?? error) }], isError: true } });
    } finally { running.delete(message.id); }
  }
  input.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    void handle(message);
  });
  const stop = () => { if (closed) return; closed = true; for (const controller of running.values()) controller.abort(); running.clear(); input.close(); };
  input.once('close', stop);
  return { stop };
}
