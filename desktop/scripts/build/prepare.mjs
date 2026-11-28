import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { desktopRoot } from './shared/paths.mjs';
import { buildPlatform } from './shared/platform.mjs';

const target = buildPlatform(process.platform);
const entry = path.join(desktopRoot, 'scripts/build', target.name, 'prepare.' + (target.name === 'windows' ? 'ps1' : 'mjs'));
const windows = target.name === 'windows';
const result = spawnSync(windows ? 'powershell' : process.execPath,
  windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry] : [entry],
  { cwd: desktopRoot, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
