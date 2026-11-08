import { describe, it, expect, vi } from 'vitest';
import { prepareGltf } from './gltfResources';
const read = vi.hoisted(() => vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])));
vi.mock('../../host-adapter/preview/resources', () => ({ readPreviewResource: read }));
describe('glTF companion resources', () => {
  it('embeds local buffers and textures through the scoped host', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ buffers: [{ uri: 'model.bin' }], images: [{ uri: '../tex/chart.png' }] }));
    const result = JSON.parse(new TextDecoder().decode(await prepareGltf(bytes, 'D:/repo/models/model.gltf', 'D:/repo')));
    expect(result.buffers[0].uri).toBe('data:application/octet-stream;base64,AQID');
    expect(result.images[0].uri).toBe('data:image/png;base64,AQID');
    expect(read).toHaveBeenCalledWith('D:/repo/tex/chart.png', 'D:/repo');
  });
  it('rejects external and escaped resources rather than silently losing geometry', async () => {
    for (const uri of ['../../private.bin', 'https://example.com/model.bin']) {
      await expect(prepareGltf(new TextEncoder().encode(JSON.stringify({ buffers: [{ uri }] })), 'D:/repo/model.gltf', 'D:/repo')).rejects.toThrow('不在当前项目内');
    }
  });
  it('embeds external GLB textures while preserving the binary chunk', async () => {
    const json = new TextEncoder().encode(JSON.stringify({ images: [{ uri: 'tex.png' }], buffers: [{ byteLength: 4 }] }));
    const length = Math.ceil(json.length / 4) * 4;
    const glb = new Uint8Array(12 + 8 + length + 12); const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.length, true);
    view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true); glb.fill(32, 20, 20 + length); glb.set(json, 20);
    view.setUint32(20 + length, 4, true); view.setUint32(24 + length, 0x004e4942, true); glb.set([4, 3, 2, 1], 28 + length);
    const result = await prepareGltf(glb, 'D:/repo/model.glb', 'D:/repo'); const output = new DataView(result.buffer);
    const doc = JSON.parse(new TextDecoder().decode(result.subarray(20, 20 + output.getUint32(12, true))));
    expect(doc.images[0].uri).toBe('data:image/png;base64,AQID'); expect([...result.slice(-4)]).toEqual([4, 3, 2, 1]);
    expect(output.getUint32(8, true)).toBe(result.length);
  });
});
