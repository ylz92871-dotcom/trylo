import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { prepareOfficeRuntime } from './build/shared/preview/prepare-office-runtime.mjs';
import { prepareDevWgcRuntime } from './prepare-dev-wgc-runtime.mjs';

const [executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error('Cargo did not provide a Desktop executable.');
const integrity = process.env.TRYLO_DESKTOP_INTEGRITY ?? 'M';
if (!['M', 'H'].includes(integrity)) {
  throw new Error('TRYLO_DESKTOP_INTEGRITY must be M or explicitly selected H.');
}
const debugExecutable = fileURLToPath(new URL('../src-tauri/target/debug/trylo-desktop.exe', import.meta.url));
if (integrity === 'H' && resolve(executable).toLowerCase() !== debugExecutable.toLowerCase()) {
  throw new Error('High development mode is limited to this checkout\'s debug Desktop executable.');
}
const prepare = fileURLToPath(new URL('./build/windows/prepare-native-executable.ps1', import.meta.url));
const prepared = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', prepare, '-ExecutablePath', executable, '-IntegrityLevel', integrity], {
  stdio: 'inherit', windowsHide: true,
});
if (prepared.error) throw prepared.error;
if (prepared.status !== 0) process.exit(prepared.status ?? 1);

// Every resource copy can inherit Low again from target/debug, including
// terminal workers, service helpers and media converters, not only Node.
if (process.platform === 'win32') {
  const prepareRuntime = fileURLToPath(new URL('./build/windows/prepare-native-dev-runtimes.ps1', import.meta.url));
  const runtime = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', prepareRuntime, '-ExecutablePath', executable, '-IntegrityLevel', integrity], {
    stdio: 'inherit', windowsHide: true,
  });
  if (runtime.error) throw runtime.error;
  if (runtime.status !== 0) process.exit(runtime.status ?? 1);
  if (resolve(executable).toLowerCase() === debugExecutable.toLowerCase()) {
    const capture = await prepareDevWgcRuntime(integrity);
    console.log(capture.skipped
      ? `Development capture helper preparation skipped: ${capture.skipped}.`
      : `Prepared verified development capture helper at integrity (${capture.integrity}).`);
  }
}

// Cargo's runner runs after Tauri has copied the engine into target/debug.
// Prepare that copy too, rather than only the original staged distribution.
const officeRoot = resolve(dirname(executable), 'preview/office');
if (process.platform === 'win32' && existsSync(resolve(officeRoot, 'manifest.json'))) {
  try {
    const office = await prepareOfficeRuntime(officeRoot);
    console.log(`Prepared verified Office runtime: ${office.executableCount} executable labels at Medium.`);
  } catch (error) {
    // An optional document provider must not prevent the Desktop from opening.
    // Its own first-use verifier/recovery remains responsible for that viewer.
    console.warn(`Office page preview preparation failed: ${error.message}`);
  }
}

// High requires an explicit environment or checkout-local choice.
// The preparation helper validates the exact Desktop path.
// Running here keeps Cargo/Tauri in charge of build and restart lifecycle.
const app = spawnSync(executable, args, { stdio: 'inherit', windowsHide: false });
if (app.error) throw app.error;
process.exit(app.status ?? 1);
