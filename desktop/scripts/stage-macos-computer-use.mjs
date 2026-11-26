import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACOS_COMPUTER_EXECUTABLE, MACOS_COMPUTER_VERSION } from '../../desktop-services/src/tooling/macos-computer-contract.mjs';
import { workspacePath } from '../../scripts/workspace-paths.mjs';

const source = fileURLToPath(new URL('../../desktop-services/toolchain/computer-control/macos-mcp/', import.meta.url));

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
      '-module-cache-path', cache, '-o', candidate, path.join(source, 'Computer.swift'), path.join(source, 'Server.swift')], { stdio: 'inherit' });
    const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
    if (version !== `trylo-macos-mcp ${MACOS_COMPUTER_VERSION}`) throw new Error(`Unexpected macOS Computer Use version: ${version}`);
    renameSync(candidate, executable);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
