// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, toNamespacedPath } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { LoopEvent } from './loop-events';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; }, fs: {
  async readFile(path: string) { return readFileSync(path, 'utf8'); },
  async statFile(path: string) { return { size: statSync(path).size }; },
} } }));
vi.mock('../runtime/cli-runtime-guard', () => ({ verifyCliRuntime: vi.fn(async () => ({ ok: true })) }));
const { CodeRunController } = await import('../runtime/code-run-controller');

it.runIf(Boolean(process.env.TRYLO_DESKTOP_LEGACY_ENTRY))(
  'the production controller switches legacy → v1 → legacy → v1 using real processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trylo-dual-cli-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const home = join(root, 'home'); mkdirSync(home);
    writeFileSync(join(workspace, 'package.json'), '{"name":"dual-cli-proof"}');
    const server = createServer(async (incoming, outgoing) => {
      let body = ''; for await (const chunk of incoming) body += chunk;
      if (incoming.url?.includes('count_tokens')) { outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end('{"input_tokens":10}'); return; }
      if (incoming.method !== 'POST' || !incoming.url?.includes('/messages')) {
        outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end('{"data":[]}'); return;
      }
      const input = JSON.parse(body) as { model: string };
      const message = { id: 'msg_dual_cli', type: 'message', role: 'assistant', model: input.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [type, data] of [
        ['message_start', { message }], ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'LEGACY ENGINE VERIFIED' } }],
        ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', {}],
      ] as const) outgoing.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      outgoing.end();
    });
    await new Promise<void>(resolveValue => server.listen(0, '127.0.0.1', resolveValue));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: home, HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'), DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', TRYLO_API_KEY: '', TRYLO_OPENAI_API_KEY: '' });
    h.service = service;
    const registry = new CodePermissionRegistry({ onChange() {}, send: async (id, line) => { await service.send(id as never, line); return true; } });
    const controller = new CodeRunController({ projectKey: 'project', conversationId: 'conversation', onChange() {}, permissions: registry });
    try {
      for (const protocol of ['legacy-stream-json', 'trylo-v1', 'legacy-stream-json', 'trylo-v1'] as const) {
        const entry = resolve(protocol === 'trylo-v1' ? process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js' : process.env.TRYLO_DESKTOP_LEGACY_ENTRY!);
        let finish!: () => void; const terminal = new Promise<void>(resolveValue => { finish = resolveValue; });
        const events: LoopEvent[] = [];
        await controller.run({ prompt: 'Verify the selected engine', codeMode: 'agent', permissionLevel: 'unrestricted', priorMessages: [],
          settings: { cwd: workspace as never, cliRuntimeProtocol: protocol, cliNodeProgram: process.env.TRYLO_DESKTOP_PACKAGED_NODE ?? process.execPath,
            cliPath: (process.platform === 'win32' ? toNamespacedPath(entry) : entry) as never,
            ...(protocol === 'trylo-v1' ? { providerId: 'fixture-write' } : {
              apiFormat: 'anthropic' as const, apiKey: 'local-contract-key', apiHost: `http://127.0.0.1:${address.port}`, apiModel: 'local-dual-cli',
            }) },
          onEvents: batch => { events.push(...batch); if (batch.some(event => event.type === 'loop_end')) finish(); } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([terminal, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`No terminal from ${protocol}`)), 30000); })]); }
        finally { clearTimeout(timer); }
        expect(events.filter(event => event.type === 'loop_end')).toMatchObject([{ isError: false }]);
        expect(controller.getViewState().running).toBe(false);
        if (protocol === 'legacy-stream-json') expect(JSON.stringify(events)).toContain('LEGACY ENGINE VERIFIED');
        else { expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(true); expect(readFileSync(join(workspace, 'fixture-output.txt'), 'utf8')).toBe('the fixture wrote this line'); }
      }
      const turns = service.argv.filter(argv => argv.includes('run') || argv.includes('-p'));
      expect(turns).toHaveLength(4);
      const newer = turns.filter(argv => argv.includes('run'));
      expect(newer).toHaveLength(2);
      expect(newer.every(argv => argv.includes('--session') && !argv.includes('--resume'))).toBe(true);
      expect(registry.list()).toHaveLength(0);
    } finally {
      await controller.stop(); await service.dispose(); server.closeAllConnections();
      await new Promise<void>(resolveValue => server.close(() => resolveValue()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
