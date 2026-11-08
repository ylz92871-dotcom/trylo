import { localResourcePath } from '../../host-adapter/preview/resource-path';
import { readPreviewResource } from '../../host-adapter/preview/resources';

/** Scoped, bounded companion reads for glTF/GLB and OBJ materials. */
export class ModelResources {
  private total = 0;
  private readonly cache = new Map<string, Uint8Array>();
  constructor(private readonly root?: string, private readonly signal?: AbortSignal) {}
  async read(documentPath: string, uri: string): Promise<{ path: string; bytes: Uint8Array }> {
    this.signal?.throwIfAborted();
    const target = this.root ? localResourcePath(documentPath, this.root, uri) : undefined;
    if (!target || !this.root) throw new Error(`模型资源不在当前项目内：${uri}`);
    let bytes = this.cache.get(target);
    if (!bytes) {
      if (this.cache.size >= 64) throw new Error('模型资源超过 64 个，请使用外部应用打开');
      bytes = await readPreviewResource(target, this.root);
      this.signal?.throwIfAborted(); this.total += bytes.byteLength;
      if (this.total > 40 * 1024 * 1024) throw new Error('模型关联资源超过 40 MB，请使用外部应用打开');
      this.cache.set(target, bytes);
    }
    return { path: target, bytes };
  }
}
export function modelDataUrl(bytes: Uint8Array, path: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const mime = /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp' : /\.gif$/i.test(path) ? 'image/gif' : 'application/octet-stream';
  return `data:${mime};base64,${btoa(binary)}`;
}
export async function prepareGltfResources(bytes: Uint8Array, path: string, root?: string, signal?: AbortSignal): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const glb = bytes.length >= 12 && view.getUint32(0, true) === 0x46546c67;
  const chunks: { type: number; bytes: Uint8Array }[] = [];
  if (glb) {
    if (view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) throw new Error('GLB 文件头无效');
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw new Error('GLB 数据块不完整');
      const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
      if (length % 4 || offset + 8 + length > bytes.length) throw new Error('GLB 数据块越界');
      chunks.push({ type, bytes: bytes.subarray(offset + 8, offset + 8 + length) }); offset += 8 + length;
    }
    if (chunks[0]?.type !== 0x4e4f534a) throw new Error('GLB 缺少 JSON 数据块');
  }
  const json = glb ? chunks[0]!.bytes : bytes;
  const document = JSON.parse(new TextDecoder().decode(json)) as { buffers?: { uri?: string }[]; images?: { uri?: string; mimeType?: string }[] };
  const resources = [...(document.buffers ?? []), ...(document.images ?? [])];
  if (resources.length > 64) throw new Error('模型资源超过 64 个，请使用外部应用打开');
  const reader = new ModelResources(root, signal);
  for (const resource of resources) {
    const uri = resource.uri;
    if (!uri || uri.startsWith('data:')) continue;
    const data = await reader.read(path, uri); resource.uri = modelDataUrl(data.bytes, data.path);
  }
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  if (!glb) return encoded;
  const padded = new Uint8Array(Math.ceil(encoded.length / 4) * 4); padded.fill(32); padded.set(encoded);
  chunks[0] = { type: 0x4e4f534a, bytes: padded };
  const output = new Uint8Array(12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.length, 0));
  const header = new DataView(output.buffer); header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, output.length, true);
  let offset = 12;
  for (const chunk of chunks) { header.setUint32(offset, chunk.bytes.length, true); header.setUint32(offset + 4, chunk.type, true); output.set(chunk.bytes, offset + 8); offset += 8 + chunk.bytes.length; }
  return output;
}
