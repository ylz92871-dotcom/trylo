import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDevResources } from './prepare-dev-resources.mjs';
import { ensureDevelopmentCli } from './ensure-dev-cli.mjs';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const environment = { ...process.env };
let devResourceConfig;

// The staged runtime may inherit a Low integrity label from release staging.
// Source services write the normal Desktop data directory, so dev must use
// the same interpreter that launched this script. Installed builds retain
// their bundled resolver; an explicit operator override remains authoritative.
if (!args.some(arg => arg === '--help' || arg === '-h') && !environment.TRYLO_NODE_BINARY?.trim()) {
  environment.TRYLO_NODE_BINARY = process.execPath;
}

// Dev uses the checkout being edited, rather than the last staged release
// resources that the native resolver otherwise prefers. Operator overrides
// remain authoritative; installed builds still use the bundled resolver.
if (!args.some(arg => arg === '--help' || arg === '-h') && !environment.TRYLO_CLI_SCRIPT?.trim()) {
  ensureDevelopmentCli();
  const cliScript = resolve(desktopRoot, '../new trylo cli/dist/cmd/trylo/main.js');
  if (!existsSync(cliScript)) {
    throw new Error('Build the new CLI before starting Desktop dev: run npm run build in new trylo cli.');
  }
  environment.TRYLO_CLI_SCRIPT = cliScript;
}

// Debug builds validate bundle resources too. Do not require a full release
// sidecar publish (or downloads) just to supply this checkout's manifest.
if (!args.some(arg => arg === '--help' || arg === '-h')) {
  devResourceConfig = prepareDevResources(desktopRoot);
}

// Windows cannot replace an executable still mapped by an old Desktop window.
// Ask that exact checkout's window to close; never kill it or other checkouts.
if (process.platform === 'win32' && !args.some(arg => arg === '--help' || arg === '-h')) {
  // Vite's native transforms and sandbox checks must not share a locked temp DLL.
  const developmentTemp = resolve(desktopRoot, '../Temp/desktop-dev', String(process.pid));
  mkdirSync(developmentTemp, { recursive: true });
  environment.TEMP = developmentTemp;
  environment.TMP = developmentTemp;
  const settingsPath = resolve(desktopRoot, '.trylo/native-dev.json');
  if (!environment.TRYLO_DESKTOP_INTEGRITY && existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!['M', 'H'].includes(settings.integrity)) {
      throw new Error('Local native-dev.json integrity must be M or explicitly selected H.');
    }
    environment.TRYLO_DESKTOP_INTEGRITY = settings.integrity;
  }
  const check = spawnSync('powershell.exe', ['-NoProfile', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$expected = $env:TRYLO_DEV_EXECUTABLE
$running = Get-CimInstance Win32_Process -Filter "Name = 'trylo-desktop.exe'" |
    Where-Object { $_.ExecutablePath -eq $expected }
foreach ($row in $running) {
    $app = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    if (-not $app) { continue }
    Write-Host "Closing previous Desktop window (PID $($app.Id)) before rebuilding."
    if (-not $app.CloseMainWindow() -or -not $app.WaitForExit(10000)) {
        throw "Desktop PID $($app.Id) still holds $expected. Close that instance before retrying; it was not force-stopped."
    }
}
`], {
    cwd: desktopRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, TRYLO_DEV_EXECUTABLE: resolve(desktopRoot, 'src-tauri/target/debug/trylo-desktop.exe') },
  });
  if (check.error) throw check.error;
  if (check.status !== 0) process.exit(check.status ?? 1);

  const triple = process.arch === 'arm64' ? 'AARCH64_PC_WINDOWS_MSVC' : 'X86_64_PC_WINDOWS_MSVC';
  const runnerKey = `CARGO_TARGET_${triple}_RUNNER`;
  if (!environment[runnerKey]) {
    // Cargo splits environment runners on whitespace, without shell quoting.
    // Tauri runs Cargo in src-tauri; this relative script path also works when
    // the checkout or Node installation path contains spaces.
    environment[runnerKey] = 'node ../scripts/run-native-dev.mjs';
  }

  if (!args.some(arg => arg === '-c' || arg === '--config' || arg.startsWith('--config='))) {
    const config = JSON.parse(readFileSync(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
    if (config.build?.devUrl) {
      try {
        const url = new URL('src/main.tsx?raw', `${config.build.devUrl.replace(/\/$/, '')}/`);
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        const source = readFileSync(resolve(desktopRoot, 'src/main.tsx'), 'utf8');
        // Reuse only a Vite instance serving this checkout's current entry.
        if (response.ok && (await response.text()).includes(JSON.stringify(source))) {
          args.unshift('--config', JSON.stringify({ build: { beforeDevCommand: '' } }));
          console.log(`Using existing Vite server at ${config.build.devUrl}.`);
        }
      } catch {
        // No matching live server: let Tauri start its configured dev command.
      }
    }
  }
}

const require = createRequire(import.meta.url);
// Apply before operator configs, so explicit configuration remains authoritative.
if (devResourceConfig) args.unshift('--config', JSON.stringify(devResourceConfig));
const result = spawnSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'dev', ...args], {
  cwd: desktopRoot,
  stdio: 'inherit',
  windowsHide: true,
  env: environment,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
