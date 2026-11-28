import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const mediaEngineRoot = path.resolve(process.env.TRYLO_RESOURCE_DIR ?? path.resolve(here, '../../../../src-tauri/resources'), 'preview/media');
const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
export const mediaEngineLock = JSON.parse(await readFile(path.join(here,
  appleSilicon ? 'media-engine.darwin-arm64.lock.json' : 'media-engine.lock.json'), 'utf8'));
export async function mediaFileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifyMediaEngine(root = mediaEngineRoot) {
  if (!appleSilicon && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('当前平台尚未供给本地媒体兼容引擎');
  const canonical = await realpath(root).catch(() => { throw new Error('媒体兼容引擎缺失，请修复 Trylo 安装'); });
  for (const entry of mediaEngineLock.files) {
    const file = await realpath(path.join(root, entry.path));
    const relative = path.relative(canonical, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('媒体引擎路径无效');
    const meta = await stat(file);
    if (!meta.isFile() || meta.size !== entry.size || await mediaFileDigest(file) !== entry.sha256) throw new Error(`媒体引擎校验失败：${entry.path}`);
  }
  return { encoder: path.join(canonical, mediaEngineLock.entries.encoder), probe: path.join(canonical, mediaEngineLock.entries.probe) };
}
