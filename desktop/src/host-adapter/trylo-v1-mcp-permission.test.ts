// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
const { startTryloV1 } = await import('./trylo-v1-runner');

it.each(['approve', 'deny', 'automatic', 'read_only'] as const)(
  'real MCP effect obeys Desktop %s before dispatch', async choice => {
    const root = mkdtempSync(join(tmpdir(), 'trylo-mcp-authority-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const marker = join(workspace, 'mcp-effect.txt');
    const serverFile = join(root, 'server.cjs');
    writeFileSync(serverFile, `
      const fs=require('node:fs'),readline=require('node:readline');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const q=JSON.parse(line); if(q.id===undefined)return;
        let result={};
        if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
        if(q.method==='tools/list')result={tools:[{name:'write_marker',description:'Write a marker into the isolated test workspace.',inputSchema:{type:'object',properties:{}}}]};
        if(q.method==='tools/call'){fs.writeFileSync(${JSON.stringify(marker)},'MCP approved');result={content:[{type:'text',text:'marker written'}]};}
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
      });`);
    // Canonical key order is part of the production runtime-registry checksum.
    const servers = [{ args: [serverFile], command: process.execPath, enabled: true, env: {}, name: 'authority', transport: 'stdio' }];
    const registryFile = join(root, 'mcp.json');
    writeFileSync(registryFile, JSON.stringify({ formatVersion: 1,
      checksum: createHash('sha256').update(JSON.stringify(servers)).digest('hex'), servers }));
    const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: join(root, 'home'),
      TRYLO_MCP_RUNTIME_REGISTRY: registryFile, TRYLO_MCP_RUNTIME_MODE: 'exclusive',
      TRYLO_API_KEY: 'local-contract-key', TRYLO_OPENAI_API_KEY: 'local-contract-key' });
    h.service = service;
    let approve!: (id: string) => void;
    const pending = new Promise<string>(resolveValue => { approve = resolveValue; });
    const registry = new CodePermissionRegistry({ onChange: () => {
      const request = registry.list()[0]; if (request) approve(request.requestId);
    }, send: async (id, line) => { await service.send(id as never, line); return true; } });
    const server = createServer((incoming, outgoing) => {
      let body = ''; incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => {
        const input = JSON.parse(body) as { messages: { role: string }[] };
        const done = input.messages.some(message => message.role === 'tool');
        const delta = done ? { content: 'DONE' } : { tool_calls: [{ index: 0, id: 'mcp-write', type: 'function',
          function: { name: 'mcp__authority__write_marker', arguments: '{}' } }] };
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
        outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\n`);
        outgoing.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolveValue => server.listen(0, '127.0.0.1', resolveValue));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    let exit!: () => void; const exited = new Promise<void>(resolveValue => { exit = resolveValue; });
    const level = choice === 'automatic' ? 'unrestricted' : choice === 'read_only' ? 'read_only' : 'ask';
    try {
      await startTryloV1({ cliPath: resolve(process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js') as never,
        nodeProgram: process.execPath, cwd: workspace as never, permissionLevel: level,
        providerId: 'openai-compatible', endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'local-mcp-contract', prompt: 'Write the marker',
        onEvents() {}, onExit: () => exit(), onControlFrame: (frame, processId) => registry.handleControlFrame(frame, {
          processId, projectKey: 'project', conversationId: 'conversation', projectRoot: workspace, permissionLevel: level,
        }) });
      if (choice === 'approve' || choice === 'deny') {
        const id = await Promise.race([pending, exited.then(() => { throw new Error('CLI exited before MCP approval'); })]);
        expect(registry.list()[0]?.toolName).toBe('mcp__authority__write_marker');
        expect(existsSync(marker)).toBe(false);
        expect(await registry.respond(id, choice === 'approve')).toBe(true);
      }
      await exited; await Promise.all(service.exits.values());
      const allowed = choice === 'approve' || choice === 'automatic';
      expect(existsSync(marker)).toBe(allowed);
      if (allowed) expect(readFileSync(marker, 'utf8')).toBe('MCP approved');
      expect(registry.list()).toHaveLength(0);
    } finally {
      await service.dispose(); server.closeAllConnections();
      await new Promise<void>(resolveValue => server.close(() => resolveValue()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
