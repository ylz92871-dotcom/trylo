import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ native: false, invoke: vi.fn(), convert: vi.fn((path: string) => `asset://${path}`) }));
vi.mock('../tauri-detect', () => ({ isTauri: () => mocks.native }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: mocks.convert }));
import { previewCodecUrls } from './codecs';
beforeEach(() => { mocks.native = false; mocks.invoke.mockReset(); mocks.convert.mockClear(); });
describe('native replaceable codec selection', () => {
  it('uses external installation resources for native workers', async () => {
    mocks.native = true;
    const paths = { tiffPako: 'D:/install/preview/codecs/tiff/pako.min.js', tiffUtif: 'utif', heif: 'heif', cad: 'cad', cadWasm: 'wasm' };
    mocks.invoke.mockResolvedValue(paths);
    expect((await previewCodecUrls('tiff')).tiffPako).toBe(`asset://${paths.tiffPako}`);
    expect(mocks.invoke).toHaveBeenCalledWith('preview_codec_paths', { provider: 'tiff' });
    expect(mocks.convert).toHaveBeenCalledTimes(5);
  });
  it('does not silently use embedded LGPL copies when native resources are missing', async () => {
    mocks.native = true; mocks.invoke.mockRejectedValue(new Error('missing resources'));
    await expect(previewCodecUrls('heif')).rejects.toThrow('missing resources');
  });
  it('uses locally served assets in browser development', async () => {
    expect((await previewCodecUrls('heif')).heif).toBe('/preview-codecs/heif/libheif-bundle.js');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
