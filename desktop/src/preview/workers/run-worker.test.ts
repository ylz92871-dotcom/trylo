import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPreviewWorker } from './run-worker';
class WorkerStub {
  static instances: WorkerStub[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  terminate = vi.fn(); postMessage = vi.fn();
  constructor() { WorkerStub.instances.push(this); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); WorkerStub.instances = []; });
describe('owned preview workers', () => {
  it('terminates a completed job and ignores late errors', async () => {
    vi.stubGlobal('Worker', WorkerStub);
    const result = runPreviewWorker<number>('image', {}, []);
    const worker = WorkerStub.instances[0]!; worker.onmessage?.({ data: { ok: true, result: 42 } }); worker.onerror?.({ message: 'late' });
    expect(await result).toBe(42); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('closing one viewer cancels only its own job', async () => {
    vi.stubGlobal('Worker', WorkerStub); const abort = new AbortController();
    const first = runPreviewWorker('cad', {}, [], abort.signal); const second = runPreviewWorker('cad', {}, []);
    abort.abort(); await expect(first).rejects.toHaveProperty('name', 'AbortError');
    expect(WorkerStub.instances[0]!.terminate).toHaveBeenCalledTimes(1); expect(WorkerStub.instances[1]!.terminate).not.toHaveBeenCalled();
    WorkerStub.instances[1]!.onmessage?.({ data: { ok: true, result: [] } }); await second;
  });
  it('enforces parsing deadlines and releases the worker', async () => {
    vi.useFakeTimers(); vi.stubGlobal('Worker', WorkerStub);
    const job = runPreviewWorker('cad', {}, [], undefined, 100);
    const assertion = expect(job).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(100); await assertion;
    expect(WorkerStub.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });
});
