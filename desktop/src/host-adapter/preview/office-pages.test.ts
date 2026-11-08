import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({ stat: vi.fn(), native: false, invoke: vi.fn() }));
vi.mock('../index', () => ({ hostAdapter: { fs: { statFile: mock.stat } } }));
vi.mock('../tauri-detect', () => ({ isTauri: () => mock.native }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
describe('Office page service ownership and cache', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  beforeEach(() => { vi.resetModules(); mock.native = false; mock.invoke.mockReset(); mock.stat.mockReset(); mock.stat.mockResolvedValue({ size: 10, modifiedMs: 1 }); });
  it('shares repeated mounts and invalidates cached pages after a file update', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70])));
    vi.stubGlobal('fetch', fetch);
    const service = await import('./office-pages');
    const [first, second] = await Promise.all([service.loadOfficePages('a.docx', 'root'), service.loadOfficePages('a.docx', 'root')]);
    expect(fetch).toHaveBeenCalledTimes(1); expect(first).toBe(second);
    await service.loadOfficePages('a.docx', 'root'); expect(fetch).toHaveBeenCalledTimes(1);
    mock.stat.mockResolvedValue({ size: 10, modifiedMs: 2 });
    fetch.mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70, 45])));
    const changed = await service.loadOfficePages('a.docx', 'root');
    expect(changed.length).toBe(5); expect(fetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
  it('serializes different documents and recovers after a failed conversion', async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; })).mockResolvedValue(new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetch);
    const service = await import('./office-pages');
    const first = service.loadOfficePages('a.docx', 'root');
    const second = service.loadOfficePages('b.docx', 'root');
    const failed = expect(first).rejects.toThrow('failed');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    rejectFirst(new Error('failed')); await failed;
    expect(await second).toEqual(new Uint8Array([1]));
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
  it('removing one shared subscriber does not cancel the other', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const service = await import('./office-pages'); const abort = new AbortController();
    const first = service.loadOfficePages('a.docx', 'root', abort.signal); const second = service.loadOfficePages('a.docx', 'root');
    const cancelled = expect(first).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); abort.abort(); await cancelled;
    expect((fetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(false);
    finish(new Response(new Uint8Array([1]))); expect(await second).toEqual(new Uint8Array([1])); vi.unstubAllGlobals();
  });
  it('skips cancelled queued files and releases their queue capacity', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; })).mockImplementation(() => Promise.resolve(new Response(new Uint8Array([2]))));
    vi.stubGlobal('fetch', fetch);
    const service = await import('./office-pages');
    const first = service.loadOfficePages('a.docx', 'root');
    const abort = new AbortController(); const queued = service.loadOfficePages('b.docx', 'root', abort.signal);
    const cancelled = expect(queued).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); abort.abort(); await cancelled;
    const later = service.loadOfficePages('c.docx', 'root'); finish(new Response(new Uint8Array([1])));
    await first; await later;
    expect(fetch.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).filePath)).toEqual(['a.docx', 'c.docx']); vi.unstubAllGlobals();
  });
  it('cancels only the exact native job and lets the next file proceed even if its old IPC result is late', async () => {
    mock.native = true;
    let late!: (bytes: ArrayBuffer) => void;
    let calls = 0;
    mock.invoke.mockImplementation((method: string) => {
      if (method === 'preview_office_cancel') return Promise.resolve(true);
      calls += 1; return calls === 1 ? new Promise<ArrayBuffer>((resolve) => { late = resolve; }) : Promise.resolve(new Uint8Array([2]).buffer);
    });
    const service = await import('./office-pages'); const abort = new AbortController();
    const first = service.loadOfficePages('a.docx', 'root', abort.signal);
    const cancelled = expect(first).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(calls).toBe(1));
    const originalId = mock.invoke.mock.calls[0]![1].jobId;
    abort.abort(); await cancelled;
    expect(await service.loadOfficePages('b.docx', 'root')).toEqual(new Uint8Array([2]));
    expect(mock.invoke.mock.calls.find(([method]) => method === 'preview_office_cancel')?.[1]).toEqual({ jobId: originalId });
    late(new Uint8Array([1]).buffer); await Promise.resolve();
    expect(await service.loadOfficePages('b.docx', 'root')).toEqual(new Uint8Array([2]));
  });
  it('an explicit reload does not reuse the same pending version or cache a stale result', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; })).mockResolvedValue(new Response(new Uint8Array([2])));
    vi.stubGlobal('fetch', fetch); const service = await import('./office-pages');
    const first = service.loadOfficePages('a.docx', 'root'); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    service.invalidateOfficePages('a.docx', 'root'); const reloaded = service.loadOfficePages('a.docx', 'root');
    finish(new Response(new Uint8Array([1]))); await first; expect(await reloaded).toEqual(new Uint8Array([2]));
    expect(await service.loadOfficePages('a.docx', 'root')).toEqual(new Uint8Array([2])); expect(fetch).toHaveBeenCalledTimes(2); vi.unstubAllGlobals();
  });
});
