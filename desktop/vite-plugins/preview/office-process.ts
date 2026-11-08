import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

/** A handle belongs to one spawn. Never stop converters by executable name. */
export async function runOfficeProcess(executable: string, args: string[], options: SpawnOptions, signal: AbortSignal, timeoutMs = 60_000): Promise<void> {
  signal.throwIfAborted();
  const child = spawn(executable, args, { ...options, windowsHide: true, detached: process.platform !== 'win32' });
  let failure: unknown;
  let stopping: Promise<void> | undefined;
  const stop = (reason: unknown): void => {
    failure ??= reason;
    if (stopping || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const pid = child.pid;
    stopping = new Promise<void>((resolve) => {
      if (process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        resolve(); return;
      }
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); child.kill(); }, 2_000);
      killer.once('error', () => child.kill());
      killer.once('close', () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); resolve(); });
    });
  };
  const cancel = (): void => stop(new DOMException('页面预览已取消', 'AbortError'));
  const timer = setTimeout(() => stop(new Error('页面转换超时，请重试或使用外部应用打开')), timeoutMs);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => { if (failure) reject(failure); else if (code !== 0) reject(new Error('页面转换失败')); else resolve(); });
    });
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel);
    await stopping;
  }
}

/** Serialize the entire operation, including its process and scratch cleanup. */
export class OfficeQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly jobs = new Set<AbortController>();
  private closed = false;
  async run<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('预览服务已关闭');
    if (this.jobs.size >= 8) throw new Error('待预览文档较多，请稍后重试');
    const controller = new AbortController();
    const cancel = (): void => { controller.abort(); this.jobs.delete(controller); };
    signal.addEventListener('abort', cancel, { once: true });
    this.jobs.add(controller);
    const task = this.tail.then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); });
    this.tail = task.catch(() => undefined);
    try { return await task; }
    finally { signal.removeEventListener('abort', cancel); this.jobs.delete(controller); }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.jobs) controller.abort();
    await this.tail;
  }
}
