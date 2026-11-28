// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { ControlFrame } from './control-protocol';
import type { LoopEvent } from './loop-events';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';
import { createToolRiskClassifier } from '../tooling/tool-risk-classifier';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
const { startTryloV1 } = await import('./trylo-v1-runner');

interface ProviderMessage {
  readonly role: string;
  readonly tool_call_id?: string;
  readonly content?: string;
}

interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly { readonly function: { readonly name: string } }[];
}

function respond(outgoing: ServerResponse, call?: { name: string; id: string; arguments: Record<string, unknown> }, text = ''): void {
  outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text };
  outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`);
  outgoing.end('data: [DONE]\n\n');
}

/** Only this fixture's isolated home is inspected; no shared broker is stopped. */
async function shutdownFixtureBrokers(home: string): Promise<void> {
  const directory = join(home, 'runtime', 'mcp-brokers');
  if (!existsSync(directory)) return;
  for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const address = JSON.parse(readFileSync(join(directory, file), 'utf8')) as { port: number; token: string };
    await fetch(`http://127.0.0.1:${address.port}/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'shutdown' }), signal: AbortSignal.timeout(2000),
    }).catch(() => { /* The CLI may already have closed a failed fixture host. */ });
  }
}

it('a real Desktop permission reply preserves invalid browser arguments and permits a corrected call', async () => {
  const repositoryWorkspace = resolve(import.meta.dirname, '../../../_workspace');
  const scratch = join(repositoryWorkspace, 'tmp', 'browser-refusal-integration');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'run-'));
  const workspace = join(root, 'workspace'), home = join(root, 'home');
  mkdirSync(workspace); mkdirSync(home);
  const marker = join(root, 'mcp-dispatch.jsonl');
  const serverFile = join(root, 'browser-fixture.cjs');
  writeFileSync(serverFile, `
    const fs = require('node:fs');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      let result = {};
      if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'isolated-browser-fixture', version: '1' } };
      if (request.method === 'tools/list') result = { tools: [{ name: 'browser_navigate',
        description: 'Open a complete HTTP URL in the isolated browser fixture.',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }] };
      if (request.method === 'tools/call') {
        fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(request.params) + '\\n');
        result = { content: [{ type: 'text', text: 'NAVIGATED_OK' }] };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `);
  // Runtime-registry checksums use canonical object-key order.
  const servers = [{ args: [serverFile], command: process.execPath, enabled: true, env: {},
    name: 'trylo-browser', transport: 'stdio' }];
  const registryFile = join(root, 'runtime-registry.json');
  writeFileSync(registryFile, JSON.stringify({ formatVersion: 1,
    checksum: createHash('sha256').update(JSON.stringify(servers)).digest('hex'), servers }));

  const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: home,
    TRYLO_MCP_RUNTIME_REGISTRY: registryFile, TRYLO_MCP_RUNTIME_MODE: 'exclusive', TRYLO_MCP_DISCOVERY: 'on',
    TRYLO_API_KEY: 'local-contract', TRYLO_OPENAI_API_KEY: 'local-contract' });
  h.service = service;
  const controlResponses: Record<string, unknown>[] = [], controls: ControlFrame[] = [];
  const permissions = new CodePermissionRegistry({ riskClassifier: createToolRiskClassifier(), onChange: () => {},
    send: async (processId, line) => {
      controlResponses.push(JSON.parse(line) as Record<string, unknown>);
      await service.send(processId as never, line);
      return true;
    } });
  const requests: ProviderRequest[] = [];
  let invalidResult: string | undefined, correctedResult: string | undefined;
  let invalidNeverDispatched = false;
  const provider = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', chunk => { body += String(chunk); });
    incoming.on('end', () => {
      const request = JSON.parse(body) as ProviderRequest;
      requests.push(request);
      const results = request.messages.filter(message => message.role === 'tool');
      const discovered = results.find(message => message.tool_call_id === 'discover-browser');
      const invalid = results.find(message => message.tool_call_id === 'invalid-relative');
      const corrected = results.find(message => message.tool_call_id === 'corrected-url');
      if (!discovered) {
        respond(outgoing, { name: 'mcp_search_tools', id: 'discover-browser',
          arguments: { server: 'trylo-browser', query: 'navigate', limit: 1 } });
      } else if (!invalid) {
        respond(outgoing, { name: 'mcp_call_tool', id: 'invalid-relative',
          arguments: { name: 'mcp__trylo-browser__browser_navigate', arguments: { url: 'index.html' } } });
      } else if (!corrected) {
        invalidResult = String(invalid.content);
        invalidNeverDispatched = !existsSync(marker);
        if (!invalidNeverDispatched || !invalidResult.includes('invalid_arguments')
          || !invalidResult.includes('完整的 http(s) URL')) {
          respond(outgoing, undefined, 'INVALID_ARGUMENT_RESULT_WAS_NOT_PRESERVED');
          return;
        }
        respond(outgoing, { name: 'mcp_call_tool', id: 'corrected-url',
          arguments: { name: 'mcp__trylo-browser__browser_navigate',
            arguments: { url: 'http://127.0.0.1:34567/index.html' } } });
      } else {
        correctedResult = String(corrected.content);
        respond(outgoing, undefined, correctedResult.includes('NAVIGATED_OK') ? 'DONE' : 'CORRECTION_FAILED');
      }
    });
  });
  await new Promise<void>((done, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', done);
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Local provider did not bind');
  const events: LoopEvent[] = [];
  let exited!: () => void;
  const exit = new Promise<void>(done => { exited = done; });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await startTryloV1({ cliPath: resolve(process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js') as never,
      nodeProgram: process.execPath, cwd: workspace as never, permissionLevel: 'unrestricted',
      providerId: 'openai-compatible', endpoint: `http://127.0.0.1:${address.port}/v1`,
      model: 'local-browser-refusal-contract', prompt: 'Verify an invalid navigation, correct its URL, and finish.',
      onEvents: batch => { events.push(...batch); }, onExit: () => exited(),
      onControlFrame: (frame, processId) => {
        controls.push(frame);
        permissions.handleControlFrame(frame, { processId, projectKey: 'isolated-project',
          conversationId: 'isolated-browser-refusal', projectRoot: workspace, permissionLevel: 'unrestricted',
          profileId: 'code.core.v1', managedPackageIds: ['playwright'] });
      } });
    await Promise.race([exit, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`Local integration did not exit: ${service.stderr.join('\n')}`)), 45000);
    })]);
    await Promise.all(service.exits.values());

    const frames = service.wire.map(line => JSON.parse(line) as Record<string, unknown>);
    const terminals = frames.filter(frame => frame.type === 'run_result');
    const dispatches = existsSync(marker)
      ? readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : [];
    const proof = { invalidNeverDispatched, invalidResult, correctedResult, dispatches, controlResponses,
      audits: permissions.recentAudits(), terminals, modelTools: requests.map(request => request.tools?.map(tool => tool.function.name)),
      toolResults: events.filter(event => event.type === 'tool_result'), stderr: service.stderr };
    if (process.env.TRYLO_BROWSER_REFUSAL_PROOF_DIR) {
      const output = resolve(process.env.TRYLO_BROWSER_REFUSAL_PROOF_DIR);
      if (!output.startsWith(`${repositoryWorkspace}\\`) && !output.startsWith(`${repositoryWorkspace}/`)) {
        throw new Error('Integration evidence must stay in the repository _workspace');
      }
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'desktop-cli-integration.json'), JSON.stringify(proof, null, 2));
    }
    expect(requests[0]?.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['mcp_search_tools', 'mcp_call_tool']));
    expect(invalidNeverDispatched, JSON.stringify(proof)).toBe(true);
    expect(invalidResult).toContain('invalid_arguments');
    expect(invalidResult).toContain('完整的 http(s) URL');
    expect(invalidResult).not.toContain('policy_denied');
    expect(correctedResult).toContain('NAVIGATED_OK');
    expect(dispatches).toEqual([{ name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:34567/index.html' } }]);
    expect(controls.filter(frame => frame.kind === 'permission' && frame.toolName === 'mcp__trylo-browser__browser_navigate')).toHaveLength(2);
    expect(controlResponses).toEqual(expect.arrayContaining([expect.objectContaining({ response: expect.objectContaining({
      response: expect.objectContaining({ behavior: 'deny', reason: 'invalid_arguments', message: expect.stringContaining('完整的 http(s) URL') }),
    }) })]));
    expect(terminals).toMatchObject([{ status: 'completed', lastMessage: 'DONE' }]);
    expect(permissions.list()).toHaveLength(0);
  } finally {
    clearTimeout(deadline);
    await service.dispose();
    await shutdownFixtureBrokers(home);
    provider.closeAllConnections();
    await new Promise<void>(done => provider.close(() => done()));
    expect(root.startsWith(`${scratch}\\`) || root.startsWith(`${scratch}/`),
      'Refusing to remove a path outside the fixture scratch directory').toBe(true);
    // Windows releases a detached broker's cwd handle just after shutdown ACK.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    h.service = null;
  }
}, 60000);
