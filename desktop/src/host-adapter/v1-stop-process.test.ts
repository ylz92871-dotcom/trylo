import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
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

it.each(['natural-exit', 'blocked-interrupt', 'blocked-kill-receipt'] as const)(
  'a real child exits and releases stop during %s', async mode => {
    const never = new Promise<void>(() => {});
    class DelayedReceiptProcess extends NodeProcessFixture {
      override async send(id: ProcessId, message: string) {
        if (JSON.parse(message).request?.subtype === 'interrupt') {
          if (mode === 'blocked-kill-receipt') throw new Error('control pipe refused');
          return never;
        }
        return super.send(id, message);
      }
      override async stop(id: ProcessId) {
        await super.stop(id);
        if (mode === 'blocked-kill-receipt') return never;
      }
    }
    const service = new DelayedReceiptProcess(process.env); services.push(service); holder.process = service;
    const directory = mkdtempSync(join(tmpdir(), 'trylo-bounded-v1-stop-'));
    const script = join(directory, 'wait-for-stop.js'); scripts.push(script);
    writeFileSync(script, mode === 'natural-exit'
      ? "process.stdin.once('data',()=>setTimeout(()=>process.exit(130),200));process.stdin.resume();\n"
      : 'process.stdin.resume();setInterval(()=>{},1000);\n');
    const events: LoopEvent[] = [];
    const outcomes: string[] = [];
    const exits: number[] = [];
    const { processId, state } = await startTryloV1({ prompt: 'local lifecycle probe', cliPath: script as FilePath,
      nodeProgram: process.execPath, cwd: directory as FilePath, providerId: 'fixture', teamMode: true,
      onEvents: batch => events.push(...batch), onTerminal: outcome => outcomes.push(outcome),
      onExit: info => exits.push(info.pid) });
    expect(isTryloV1Process(processId)).toBe(true);
    await stopTryloV1(processId);
    expect(service.children.size).toBe(0);
    expect(await service.list()).toEqual([]);
    expect(exits).toHaveLength(1);
    expect(state()).toBe('exited');
    expect(isTryloV1Process(processId)).toBe(false);
    expect(service.forceStops).toHaveLength(mode === 'natural-exit' ? 0 : 1);
    const ends = events.filter(event => event.type === 'loop_end');
    expect(ends).toHaveLength(1);
    expect(outcomes).toEqual(['cancelled']);
  }, 12_000,
);
