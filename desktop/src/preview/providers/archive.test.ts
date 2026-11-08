// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../workers/run-worker', () => ({ runPreviewWorker: mocks.run }));
import { loadArchivePreview } from './archive';
import { previewKindFor } from '../formats';
import { sniffPreviewKind } from '../sniff';
beforeEach(() => mocks.run.mockReset());
it('routes common archive containers while retaining Office/3MF ZIP formats', () => {
  for (const name of ['x.rar','x.7z','x.tar.gz','x.bz2','x.xz','x.zst','x.cpio']) expect(previewKindFor(name),name).toBe('archive');
  const zip = Uint8Array.from([80,75,3,4,0,0,0,0]);
  for (const [name,kind] of [['x.docx','docx'],['x.ods','xlsx'],['x.odt','office'],['x.pptx','pptx'],['x.3mf','model3d']]) expect(sniffPreviewKind(name!,zip)).toBe(kind);
  expect(sniffPreviewKind('unknown', Uint8Array.from([55,122,188,175,39,28,0]))).toBe('archive');
  expect(sniffPreviewKind('unknown', Uint8Array.from([31,139,8,0]))).toBe('archive');
});
it('passes only copied bytes, cancels before starting a job and bounds selected reads', async () => {
  const abort = new AbortController(); abort.abort();
  await expect(loadArchivePreview(new Uint8Array([1]),'x.tar',abort.signal)).rejects.toHaveProperty('name','AbortError');
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.run.mockResolvedValueOnce([{ id:0,name:'x',size:11*1024*1024,readable:true }]);
  const input = new Uint8Array([31,139,0]);
  const archive = await loadArchivePreview(input,'x.gz',new AbortController().signal);
  expect(mocks.run.mock.calls[0]![0]).toBe('archive');
  expect(mocks.run.mock.calls[0]![1].buffer).not.toBe(input.buffer);
  expect(mocks.run.mock.calls[0]![4]).toBe(8000);
  await expect(archive.read(0,new AbortController().signal)).rejects.toThrow('10 MB');
  expect(mocks.run).toHaveBeenCalledTimes(1);
});
