import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const [command, ...args] = process.argv.slice(2);
// Both pnpm tauri dev and pnpm tauri:dev need the checkout's native
// preparation, including the executable integrity label after each rebuild.
const script = command === 'dev'
  ? fileURLToPath(new URL('./start-desktop-dev.mjs', import.meta.url))
  : require.resolve('@tauri-apps/cli/tauri.js');
const result = spawnSync(process.execPath, [script, ...(command === 'dev' ? args : process.argv.slice(2))], {
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
