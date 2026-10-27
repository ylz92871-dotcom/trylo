import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const flags = ['--context-window', '--model-context-window'];
/** Avoid launching a fresh renderer against an older checkout dist. Never
 * rewrites an operator-supplied CLI or changes provider/account selection. */
export function ensureDevelopmentCli({ nodeProgram = process.execPath, run = spawnSync, log = console.log } = {}) {
  const cliRoot = fileURLToPath(new URL('../../new trylo cli/', import.meta.url));
  const entry = fileURLToPath(new URL('../../new trylo cli/dist/cmd/trylo/main.js', import.meta.url));
  const probe = () => {
    const result = run(nodeProgram, [entry, '--help'], { cwd: cliRoot, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const advertised = [...String(result.stdout || '').matchAll(/^\s{2,}(--[\w-]+)/gm)].map(match => match[1]);
    return result.status === 0 && flags.every(flag => advertised.includes(flag));
  };
  if (probe()) return;
  log('Refreshing the development CLI to support model context settings…');
  const compiler = fileURLToPath(new URL('../../new trylo cli/node_modules/typescript/bin/tsc', import.meta.url));
  for (const args of [[compiler, '-p', 'tsconfig.json'], ['scripts/copy-vendor.mjs'], ['scripts/pty/copy-pty-vendor.mjs'], ['scripts/release-inventory.mjs']]) {
    const result = run(nodeProgram, args, { cwd: cliRoot, stdio: 'inherit', timeout: 180000, windowsHide: true });
    if (result.status !== 0) throw Error('Development CLI build failed; Desktop was not started. Inspect the build error above.');
  }
  if (!probe()) throw Error('Development CLI still lacks model context options after rebuilding.');
}
