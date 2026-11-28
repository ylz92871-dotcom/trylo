import { readFile, realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaEngineLock, mediaFileDigest } from './media-engine.mjs';
import { previewCachePath } from './cache-path.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '../../../..');

/** Reject incomplete supply before NSIS/portable packaging. Runtime codec
 * hashes alone cannot establish the matching source/notice distribution. */
export async function verifyMediaRelease() {
  const sourceLock = JSON.parse(await readFile(path.join(here, 'media-sources.lock.json'), 'utf8'));
  const lock = mediaEngineLock.platform === 'darwin-arm64' ? {
    ...sourceLock,
    files: sourceLock.files.filter(file => ['ffmpeg-source.tar.gz', 'hls-js-source.tar.gz'].includes(file.name)),
    notices: mediaEngineLock.files.filter(file => ['LICENSE.txt', 'NOTICE'].includes(file.path))
      .map(file => ({ path: `preview/media/${file.path}`, bytes: file.size, sha256: file.sha256 })),
  } : sourceLock;
  const pkg = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'));
  if (lock.schemaVersion !== 1 || lock.engineVersion !== mediaEngineLock.version || lock.ffmpegCommit !== mediaEngineLock.ffmpegCommit || lock.builderCommit !== mediaEngineLock.builderCommit || pkg.dependencies['hls.js'] !== mediaEngineLock.browser.version) throw new Error('Media engine/browser/source version pins do not match');
  if (lock.complete !== true || !lock.files?.length || !lock.notices?.length) throw new Error(`Media source/notice supply is not complete; do not bundle this engine. ${lock.pending ?? ''}`);
  for (const file of mediaEngineLock.build?.recipeFiles ?? []) {
    if (!file.path.startsWith('scripts/build/shared/preview/media-build/') || await mediaFileDigest(path.join(desktop, file.path)) !== file.sha256) throw new Error(`Media build recipe differs from the accepted engine: ${file.path}`);
  }
  execFileSync(process.execPath, [path.join(here, 'stage-media-engine.mjs'), '--check'], { windowsHide: true, stdio: 'inherit' });
  const sourceDirectory = path.resolve(process.env.TRYLO_MEDIA_SOURCES_DIR ?? previewCachePath('media-sources'));
  const supplied = JSON.parse(await readFile(path.join(sourceDirectory, 'media-source-inventory.json'), 'utf8'));
  if (supplied.engineVersion !== lock.engineVersion || supplied.errors?.length || supplied.files?.length !== lock.files.length) throw new Error('Media source companion is incomplete');
  const within = async (root, relative) => {
    const canonical = await realpath(root); const target = await realpath(path.join(root, relative));
    const remainder = path.relative(canonical, target);
    if (!remainder || remainder.startsWith('..') || path.isAbsolute(remainder) || !(await stat(target)).isFile()) throw new Error(`Redirected media supply file: ${relative}`);
    return target;
  };
  for (const file of lock.files) {
    const original = supplied.files.find((entry) => entry.name === file.name);
    const target = await within(sourceDirectory, file.name);
    if (!original || original.sha256 !== file.sha256 || (await stat(target)).size !== file.bytes || await mediaFileDigest(target) !== file.sha256) throw new Error(`Media source mismatch: ${file.name}`);
  }
  const notices = [];
  const resources = path.resolve(process.env.TRYLO_RESOURCE_DIR ?? path.join(desktop, 'src-tauri/resources'));
  for (const file of lock.notices) {
    if (!file.path.startsWith('preview/media/')) throw new Error('Media notice is outside its resource owner');
    const target = await within(resources, file.path);
    if ((await stat(target)).size !== file.bytes || await mediaFileDigest(target) !== file.sha256) throw new Error(`Media notice mismatch: ${file.path}`);
    notices.push({ path: file.path, sha256: file.sha256 });
  }
  return { lock, sourceDirectory, notices, recipes: (mediaEngineLock.build?.recipeFiles ?? []).map((file) => file.path) };
}
