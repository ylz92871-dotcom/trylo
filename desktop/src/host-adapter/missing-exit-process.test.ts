import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessExitInfo, ProcessService } from './process-service';
import type { FilePath, ProcessId } from './types';
import type { LoopEvent } from './loop-events';

const holder = vi.hoisted(() => ({ process: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return holder.process; } } }));
const { startTryloV1, stopTryloV1, isTryloV1Process } = await import('./trylo-v1-runner');
const services: NodeProcessFixture[] = [];
const scripts: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  for (const script of scripts.splice(0)) { unlinkSync(script); rmdirSync(join(script, '..')); }
});

it.each(['acknowledged', 'refused', 'list-retry'] as const)(
  'a reaped real child with a lost exit callback releases through %s native confirmation', async mode => {
    class LostCallbackProcess extends NodeProcessFixture {
      failList = false;
      readonly callbacks: (() => void)[] = [];
      override async spawn(opts: Parameters<ProcessService['spawn']>[0]) {
        return super.spawn({ ...opts, onExit: info => { this.callbacks.push(() => opts.onExit?.(info)); } });
      }
      override async stop(id: ProcessId) {
        if (mode !== 'acknowledged') throw new Error('native stop receipt unavailable');
        return super.stop(id);
      }
      override async list() {
        if (this.failList) throw new Error('native list unavailable');
        return super.list();
      }
      override async dispose() {
        // Test refusal does not apply to fixture teardown of the unrelated child.
        await Promise.all([...this.children.keys()].map(id => super.stop(id)));
        for (const callback of this.callbacks.splice(0)) callback();
      }
    }
    const service = new LostCallbackProcess(process.env); services.push(service); holder.process = service;
    const directory = mkdtempSync(join(tmpdir(), 'trylo-missing-exit-'));
    const script = join(directory, 'native-exit.js'); scripts.push(script);
    writeFileSync(script, "process.stdin.once('data',()=>process.exit(0));process.stdin.resume();\n");
    const events: LoopEvent[] = [];
    const outcomes: string[] = [];
    const exits: ProcessExitInfo[] = [];
    const run = await startTryloV1({ prompt: 'local lost-callback probe', cliPath: script as FilePath,
      nodeProgram: process.execPath, cwd: directory as FilePath, providerId: 'fixture', teamMode: true,
      onEvents: batch => events.push(...batch), onTerminal: outcome => outcomes.push(outcome),
      onExit: info => exits.push(info) });
    await service.exits.get(run.processId); // Real close has happened; only display delivery is suppressed.
    const other = await service.spawn({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      label: 'unrelated-owned-fixture', cwd: directory, onOutput: () => {} });
    try {
      expect((await service.list()).map(row => row.id)).toEqual([other.id]);
      expect(isTryloV1Process(run.processId)).toBe(true);
      expect(exits).toEqual([]);
      if (mode === 'list-retry') {
        service.failList = true;
        await expect(stopTryloV1(run.processId)).rejects.toBeInstanceOf(AggregateError);
        expect(isTryloV1Process(run.processId)).toBe(true);
        expect(exits).toEqual([]);
        service.failList = false;
      }
      await stopTryloV1(run.processId);
      expect(isTryloV1Process(run.processId)).toBe(false);
      expect(run.state()).toBe('exited');
      expect(outcomes).toEqual(['cancelled']);
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({ id: run.processId, code: null, outputComplete: false });
      expect(events.filter(event => event.type === 'loop_end')).toHaveLength(1);
      expect(service.children.has(other.id)).toBe(true);
      expect(service.forceStops).not.toContain(other.id);
      service.callbacks.splice(0).forEach(callback => callback());
      expect(exits).toHaveLength(1);
      expect(outcomes).toEqual(['cancelled']);
    } finally {
      service.failList = false;
      await service.dispose();
      expect(service.children.size).toBe(0);
      expect(await service.list()).toEqual([]);
    }
  }, 12_000,
);
