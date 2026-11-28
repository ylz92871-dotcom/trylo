import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createToolCatalog } from '../../../../desktop-services/src/tooling/tool-catalog.mjs';
import { createToolPackageManager } from '../../../../desktop-services/src/tooling/tool-package-manager.mjs';
import { writeBuiltinInventory } from '../shared/builtin-tools-inventory.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export async function stageBuiltinTools({ target, officeArtifact } = {}) {
  if (!target) throw new Error('An explicit bundle target is required');
  if (existsSync(target)) throw new Error(`Refuse to merge with an existing built-in bundle: ${target}`);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple Silicon built-in tools require darwin-arm64');
  await fs.mkdir(target, { recursive: true });
  const tools = {};
  const register = async (id, entry, version, args = []) => {
    tools[id] = { policy: 'bundled', entry, version, args, sha256: sha(await fs.readFile(path.join(target, entry))) };
  };
    const catalog = createToolCatalog({ supportedOnly: true });
    const installRoot = path.join(target, 'packages');
    const manager = createToolPackageManager({ catalog, installRoot });
    for (const { id, version } of catalog.list()) {
      const result = await manager.install({ id, ...(id === 'officecli' && officeArtifact ? { archivePath: officeArtifact.path } : {}) });
      if (!result.ok) throw new Error(`Could not stage ${id}: ${result.reasonCode}: ${result.error ?? ''}`);
      const entry = path.relative(target, result.executable);
      await register(id, entry, version);
      if (id === 'officecli') {
        const notices = path.join(repo, 'desktop-services/licenses/officecli');
        for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) {
          await fs.copyFile(path.join(notices, name), path.join(result.installDir, name));
        }
      }
    }
    await fs.rm(path.join(installRoot, '.downloads'), { recursive: true, force: true });
    return writeBuiltinInventory(target, tools);
}
