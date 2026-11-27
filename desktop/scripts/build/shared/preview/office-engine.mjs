// First-use verifier for the development host. Packaging still checks every
// payload byte; do not import the staging executable from a running server.
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const lock = JSON.parse(await readFile(new URL('./office-engine.lock.json', import.meta.url), 'utf8'));
export async function verifyOfficeRuntime(root) {
  const manifestFile = path.join(root, 'manifest.json');
  if ((await stat(manifestFile)).size > 5 * 1024 * 1024) throw new Error('Office 引擎清单过大');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.provider !== lock.provider || manifest.version !== lock.version || manifest.buildId !== lock.buildId || manifest.runtimeProfile !== lock.runtimeProfile || manifest.entry !== 'program/soffice.com' || !Array.isArray(manifest.files) || manifest.files.length > 20_000) throw new Error('Office 引擎版本与发行配置不一致');
  const entries = [...manifest.files].map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (createHash('sha256').update(JSON.stringify(entries)).digest('hex') !== lock.distributionFilesSha256) throw new Error('Office 引擎文件清单校验失败');
  const canonicalRoot = await realpath(root);
  for (const [name, expected] of Object.entries(lock.criticalFiles)) {
    const target = await realpath(path.join(root, name));
    const relative = path.relative(canonicalRoot, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Office 引擎文件超出资源目录');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw new Error(`Office 引擎校验失败：${name}`);
  }
  for (const name of ['program/services.rdb', 'program/fundamental.ini', 'license.txt', 'LICENSE.html', 'NOTICE']) {
    if (!(await stat(path.join(root, name))).isFile()) throw new Error(`Office 引擎文件缺失：${name}`);
  }
  return path.join(root, manifest.entry);
}
