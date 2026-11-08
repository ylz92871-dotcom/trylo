import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 512;
const MAX_BYTES = 2 * 1024 * 1024;

/** Per-server extension registry only. Document settings/history stay private. */
export class OfficeExtensionCache {
  private seed?: { relative: string; bytes: Buffer }[];

  async restore(profile: string): Promise<void> {
    if (!this.seed) return;
    const root = path.join(profile, 'user/extensions');
    await fs.mkdir(root); // Refuse any existing extension state.
    for (const file of this.seed) {
      const target = path.join(root, file.relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.bytes, { flag: 'wx' });
    }
  }

  async capture(profile: string, signal: AbortSignal): Promise<void> {
    if (this.seed) return;
    try {
      const initial = path.join(profile, 'user/extensions');
      if ((await fs.lstat(initial)).isSymbolicLink()) return;
      const root = await fs.realpath(initial);
      const lock = JSON.parse(await fs.readFile(new URL('../../scripts/preview/office-engine.lock.json', import.meta.url), 'utf8')) as { buildId: string };
      const pending = [root];
      const files: { relative: string; bytes: Buffer }[] = [];
      let entries = 0; let total = 0;
      while (pending.length) {
        const directory = pending.pop()!;
        for await (const child of await fs.opendir(directory)) {
          signal.throwIfAborted();
          if (++entries > MAX_ENTRIES) return;
          const target = path.join(directory, child.name);
          const relative = path.relative(root, target);
          const parts = relative.split(path.sep);
          if (parts.length > 12 || parts.some((part) => !part || part === '.' || part === '..') || path.isAbsolute(relative)) return;
          const stat = await fs.lstat(target);
          if (stat.isSymbolicLink()) return;
          const canonical = path.relative(root, await fs.realpath(target));
          if (canonical === '..' || canonical.startsWith(`..${path.sep}`) || path.isAbsolute(canonical)) return;
          if (stat.isDirectory()) { pending.push(target); continue; }
          if (!stat.isFile() || stat.size > MAX_BYTES - total) return;
          const input = await fs.open(target, 'r');
          const chunks: Buffer[] = []; let size = 0;
          try {
            for await (const chunk of input.createReadStream({ autoClose: false })) {
              signal.throwIfAborted(); size += chunk.length;
              if (total + size > MAX_BYTES) return;
              chunks.push(chunk);
            }
          } finally { await input.close(); }
          total += size;
          files.push({ relative, bytes: Buffer.concat(chunks, size) });
        }
      }
      if (files.find((file) => file.relative === 'buildid')?.bytes.toString('utf8').trimEnd() !== lock.buildId) return;
      signal.throwIfAborted();
      this.seed = files;
    } catch {
      // A failed optional cache snapshot never invalidates a generated PDF.
    }
  }
}
