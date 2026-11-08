// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { OfficeQueue, runOfficeProcess } from './office-process';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
describe('development Office process ownership', () => {
  it('cancels its real child tree while leaving an unrelated process alive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trylo-office-process-test-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    cleanup.push(async () => { sibling.kill(); await new Promise<void>((resolve) => { if (sibling.exitCode !== null || sibling.signalCode !== null) resolve(); else sibling.once('close', () => resolve()); }); });
    const abort = new AbortController();
    const ready = path.join(root, 'ready.json');
    const script = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)";
    const task = runOfficeProcess(process.execPath, ['-e', script, ready], { stdio: 'ignore' }, abort.signal);
    const cancelled = expect(task).rejects.toHaveProperty('name', 'AbortError');
    cleanup.push(async () => { abort.abort(); await task.catch(() => undefined); });
    let pids: number[] = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { pids = JSON.parse(await readFile(ready, 'utf8')) as number[]; break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    expect(pids).toHaveLength(2);
    abort.abort(); await cancelled;
    const stopped = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };
    const reaped = Date.now() + 2_000;
    while (pids.some((pid) => !stopped(pid)) && Date.now() < reaped) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pids.every(stopped)).toBe(true);
    expect(sibling.exitCode).toBeNull(); expect(sibling.signalCode).toBeNull();
  }, 15_000);
  it('bounds a stuck process and accepts a later successful conversion', async () => {
    await expect(runOfficeProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }, new AbortController().signal, 150)).rejects.toThrow('超时');
    await runOfficeProcess(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }, new AbortController().signal);
  }, 10_000);
});
describe('development Office queue', () => {
  it('waits for cancellation cleanup before starting the next job and skips a cancelled queued job', async () => {
    const queue = new OfficeQueue(); const firstAbort = new AbortController(); const queuedAbort = new AbortController();
    const events: string[] = [];
    const first = queue.run(firstAbort.signal, (signal) => new Promise<void>((resolve) => {
      events.push('first'); signal.addEventListener('abort', () => { events.push('stopping'); setTimeout(() => { events.push('cleaned'); resolve(); }, 30); }, { once: true });
    }));
    const skipped = queue.run(queuedAbort.signal, async () => { events.push('should-not-start'); });
    const skippedResult = expect(skipped).rejects.toHaveProperty('name', 'AbortError');
    const next = queue.run(new AbortController().signal, async () => { events.push('next'); });
    await new Promise((resolve) => setTimeout(resolve, 0)); queuedAbort.abort(); firstAbort.abort();
    await first; await skippedResult; await next;
    expect(events).toEqual(['first', 'stopping', 'cleaned', 'next']);
    await queue.close();
    await expect(queue.run(new AbortController().signal, async () => undefined)).rejects.toThrow('关闭');
  });
});
