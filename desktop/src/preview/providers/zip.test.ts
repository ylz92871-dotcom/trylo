// @vitest-environment node
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { inspectZip, loadZipPreview } from './zip';
it('lists Unix symbolic links without treating the target as readable file data', async () => {
  const zip = new JSZip(); zip.file('link', '../../outside.txt', { unixPermissions: 0o120777 });
  const bytes = await zip.generateAsync({ type: 'uint8array', platform: 'UNIX' });
  const preview = await loadZipPreview(bytes, new AbortController().signal);
  expect(preview.entries[0]?.readable).toBe(false);
  await expect(preview.read(0, new AbortController().signal)).rejects.toThrow('链接或特殊条目');
});
it('lists and reads genuine compressed UTF-8/nested entries without extracting host paths', async () => {
  const zip = new JSZip(); zip.file('资料/main.py', 'print("saved")'); zip.file('tail.txt', 'final line');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const preview = await loadZipPreview(bytes, new AbortController().signal);
  const selected = preview.entries.find((entry) => entry.name === '资料/main.py')!;
  expect(new TextDecoder().decode(await preview.read(selected.id, new AbortController().signal))).toBe('print("saved")');
  const malicious = new JSZip(); malicious.file('../../outside.txt', 'remains in memory');
  const archive = await loadZipPreview(await malicious.generateAsync({ type: 'uint8array' }), new AbortController().signal);
  const item = archive.entries.find((entry) => entry.name === '../../outside.txt')!;
  expect(new TextDecoder().decode(await archive.read(item.id, new AbortController().signal))).toBe('remains in memory');
});
it('rejects corrupt directories and oversized decoded entries before decompression', async () => {
  const zip = new JSZip(); zip.file('large.txt', 'x');
  const bytes = await zip.generateAsync({ type: 'uint8array' }); const view = new DataView(bytes.buffer);
  const central = bytes.findIndex((_, index) => index + 4 < bytes.length && view.getUint32(index, true) === 0x02014b50);
  view.setUint32(central + 24, 11 * 1024 * 1024, true);
  const archive = await loadZipPreview(bytes, new AbortController().signal);
  await expect(archive.read(0, new AbortController().signal)).rejects.toThrow('10 MB');
  expect(() => inspectZip(bytes.subarray(0, bytes.length - 3))).toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(loadZipPreview(bytes, controller.signal)).rejects.toThrow();
});
it('also bounds actual inflated bytes when directory metadata understates the size', async () => {
  const zip = new JSZip(); zip.file('understated.txt', 'x'.repeat(11 * 1024 * 1024));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }); const view = new DataView(bytes.buffer);
  const central = bytes.findIndex((_, index) => index + 4 < bytes.length && view.getUint32(index, true) === 0x02014b50);
  view.setUint32(central + 24, 1, true);
  const preview = await loadZipPreview(bytes, new AbortController().signal);
  await expect(preview.read(0, new AbortController().signal)).rejects.toThrow('10 MB');
});
