import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACOS_COMPUTER_EXECUTABLE, MACOS_COMPUTER_VERSION } from '../../../../desktop-services/src/tooling/macos-computer-contract.mjs';
import { workspacePath } from '../../../../scripts/workspace-paths.mjs';

const source = fileURLToPath(new URL('../../../../desktop-services/toolchain/computer-control/macos-mcp/', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(source, 'SOURCES.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0
    || manifest.files.some(file => typeof file !== 'string' || !/^[A-Za-z0-9_-]+\.swift$/.test(file))
    || new Set(manifest.files).size !== manifest.files.length) throw new Error('Invalid macOS computer source manifest');
const sourceFiles = manifest.files.map(file => path.join(source, file));

export function stageMacosComputerUse(resources) {
  const executable = path.join(resources, 'desktop-services', MACOS_COMPUTER_EXECUTABLE);
  const parent = path.dirname(executable);
  const cache = workspacePath('cache', 'desktop', 'swift');
  mkdirSync(cache, { recursive: true });
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, '.build-'));
  const candidate = path.join(staging, path.basename(executable));
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-target', 'arm64-apple-macos14.0', '-O', '-warnings-as-errors',
      '-module-cache-path', cache, '-o', candidate, ...sourceFiles], { stdio: 'inherit' });
    const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
    if (version !== `trylo-macos-mcp ${MACOS_COMPUTER_VERSION}`) throw new Error(`Unexpected macOS Computer Use version: ${version}`);
    renameSync(candidate, executable);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
