import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePinnedWgcHelper } from '../../desktop-services/src/tooling/tool-package-manager.mjs';
import { WINDOWS_MCP_MANIFEST } from '../../desktop-services/src/tooling/manifests/windows-mcp.mjs';

/** The source Service Host can select a verified publish output outside target/debug. */
export async function prepareDevWgcRuntime(integrity = 'M') {
  if (process.platform !== 'win32') return { skipped: 'not Windows' };
  if (!['M', 'H'].includes(integrity)) throw new Error('Expected an existing Medium or High development choice.');
  const helper = await resolvePinnedWgcHelper(WINDOWS_MCP_MANIFEST);
  if (!helper.ok) return { skipped: helper.reasonCode };
  const checkout = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const executable = realpathSync(helper.path);
  const relative = path.relative(checkout, executable);
  // An external operator override keeps its own permissions and ownership.
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { skipped: 'external override' };
  }
  if (statSync(executable).nlink !== 1) throw new Error('Refuse a shared hard-linked development capture helper.');
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('Windows SystemRoot is missing.');
  execFileSync(path.join(systemRoot, 'System32/icacls.exe'), [executable, '/setintegritylevel', integrity], {
    windowsHide: true, stdio: 'pipe', timeout: 10000,
  });
  return { executable, integrity };
}
