// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ViteDevServer } from 'vite';
const mock = vi.hoisted(() => ({ run: vi.fn(), verify: vi.fn() }));
vi.mock('./office-process', async (original) => ({ ...await original<typeof import('./office-process')>(), runOfficeProcess: mock.run }));
vi.mock('../../scripts/preview/office-engine.mjs', () => ({ verifyOfficeRuntime: mock.verify }));
import { officePreview } from './office';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); mock.run.mockReset(); mock.verify.mockReset(); });

describe('development Office HTTP lifecycle', () => {
  it('client disconnect cancels conversion and cleans scratch before the next response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trylo-office-http-test-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'a.docx'), 'original');
    vi.stubEnv('TRYLO_PREVIEW_ENGINE_ROOT', root); mock.verify.mockResolvedValue(process.execPath);
    const events: string[] = []; const scratch: string[] = [];
    mock.run.mockImplementation(async (_exe: string, args: string[], _options: unknown, signal: AbortSignal) => {
      const out = args[args.indexOf('--outdir') + 1]!; scratch.push(out);
      if (scratch.length === 1) {
        events.push('first');
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { events.push('cancelled'); reject(new DOMException('cancelled', 'AbortError')); }, { once: true }));
      }
      // The first scratch tree must already be gone before another converter.
      await expect(readdir(scratch[0]!)).rejects.toThrow();
      events.push('next'); await writeFile(path.join(out, 'source.pdf'), '%PDF-test');
    });
    let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    const server = createServer((req, res) => { void handler(req, res); });
    const plugin = officePreview();
    (plugin.configureServer as (server: ViteDevServer) => void)({ httpServer: server, middlewares: { use: (_path: string, fn: typeof handler) => { handler = fn; } } } as unknown as ViteDevServer);
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no loopback port');
    const options = { hostname: '127.0.0.1', port: address.port, path: '/__dev_preview/office', method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const body = JSON.stringify({ filePath: path.join(root, 'a.docx'), allowedRoot: root });
    let earlyError: Error | undefined;
    const first = request(options, (res) => { let message = ''; res.on('data', (data) => { message += String(data); }); res.on('end', () => { earlyError = new Error(`Unexpected first response ${res.statusCode}: ${message}`); }); });
    first.on('error', (error) => { earlyError = error; }); first.end(body);
    await vi.waitFor(() => { if (earlyError) throw earlyError; expect(events).toEqual(['first']); }); first.destroy();
    await vi.waitFor(() => expect(events).toContain('cancelled'));
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(options, (res) => { let body = ''; res.on('data', (data) => { body += String(data); }); res.on('end', () => resolve({ status: res.statusCode!, body })); }); req.on('error', reject); req.end(body);
    });
    expect(result).toEqual({ status: 200, body: '%PDF-test' });
    expect(events).toEqual(['first', 'cancelled', 'next']);
    for (const directory of scratch) await expect(readdir(directory)).rejects.toThrow();
    expect(mock.verify).toHaveBeenCalledTimes(1);
  });
});
