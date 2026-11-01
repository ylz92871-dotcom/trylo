import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const flags = ['--context-window', '--model-context-window'];
const toolCommands = ['status', 'production-list', 'production-show', 'production-verify', 'production-activate'];
/** Avoid launching a fresh renderer against an older checkout dist. Never
 * rewrites an operator-supplied CLI or changes provider/account selection. */
export function ensureDevelopmentCli({ nodeProgram = process.execPath, run = spawnSync, log = console.log } = {}) {
  const cliRoot = fileURLToPath(new URL('../../new trylo cli/', import.meta.url));
  const entry = fileURLToPath(new URL('../../new trylo cli/dist/cmd/trylo/main.js', import.meta.url));
  const probe = () => {
    const result = run(nodeProgram, [entry, '--help'], { cwd: cliRoot, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const advertised = [...String(result.stdout || '').matchAll(/^\s{2,}(--[\w-]+)/gm)].map(match => match[1]);
    if (result.status !== 0 || !flags.every(flag => advertised.includes(flag))) return false;
    // Read-only help avoids opening the person's learning store during startup.
    const tools = run(nodeProgram, [entry, 'tools', '--help'], { cwd: cliRoot, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const commands = [...String(tools.stdout || '').matchAll(/^trylo tools ([\w-]+)/gm)].map(match => match[1]);
    return tools.status === 0 && toolCommands.every(command => commands.includes(command));
  };
  if (probe()) return;
  log('Refreshing the development CLI to support model context settings and tool management…');
  const compiler = fileURLToPath(new URL('../../new trylo cli/node_modules/typescript/bin/tsc', import.meta.url));
  for (const args of [[compiler, '-p', 'tsconfig.json'], ['scripts/copy-vendor.mjs'], ['scripts/pty/copy-pty-vendor.mjs'], ['scripts/release-inventory.mjs']]) {
    const result = run(nodeProgram, args, { cwd: cliRoot, stdio: 'inherit', timeout: 180000, windowsHide: true });
    if (result.status !== 0) throw Error('Development CLI build failed; Desktop was not started. Inspect the build error above.');
  }
  if (!probe()) throw Error('Development CLI still lacks model context options or tool management after rebuilding.');
}
