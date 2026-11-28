// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfficeExtensionCache } from './office-profile';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function profile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-office-seed-test-')); directories.push(dir);
  await fs.mkdir(path.join(dir, 'user/extensions/bundled'), { recursive: true });
  const lock = JSON.parse(await fs.readFile(new URL('../../scripts/build/shared/preview/office-engine.lock.json', import.meta.url), 'utf8')) as { buildId: string };
  await fs.writeFile(path.join(dir, 'user/extensions/buildid'), lock.buildId);
  await fs.writeFile(path.join(dir, 'user/extensions/bundled/dictionary.xcu'), '$BUNDLED_EXTENSIONS/dictionary.xml');
  await fs.writeFile(path.join(dir, 'user/registrymodifications.xcu'), 'document history');
  return dir;
}
it('copies registration to a fresh profile without carrying document settings or overwriting state', async () => {
  const cache = new OfficeExtensionCache(); const source = await profile();
  await cache.capture(source, new AbortController().signal);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-office-seed-test-')); directories.push(target);
  await fs.mkdir(path.join(target, 'user')); await fs.writeFile(path.join(target, 'user/registrymodifications.xcu'), 'fresh macro/link policy');
  await cache.restore(target);
  expect(await fs.readFile(path.join(target, 'user/registrymodifications.xcu'), 'utf8')).toBe('fresh macro/link policy');
  expect(await fs.readFile(path.join(target, 'user/extensions/bundled/dictionary.xcu'), 'utf8')).toBe('$BUNDLED_EXTENSIONS/dictionary.xml');
  await expect(cache.restore(target)).rejects.toThrow();
});
it('rejects a changed engine and oversized registration cache', async () => {
  for (const mode of ['version', 'size']) {
    const source = await profile();
    if (mode === 'version') await fs.writeFile(path.join(source, 'user/extensions/buildid'), 'different engine');
    else { const file = await fs.open(path.join(source, 'user/extensions/large'), 'w'); await file.truncate(2 * 1024 * 1024 + 1); await file.close(); }
    const cache = new OfficeExtensionCache(); await cache.capture(source, new AbortController().signal);
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-office-seed-test-')); directories.push(target); await fs.mkdir(path.join(target, 'user'));
    await cache.restore(target);
    await expect(fs.stat(path.join(target, 'user/extensions'))).rejects.toThrow();
  }
});
