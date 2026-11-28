import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { macosComputerExecutable } from './runtime.mjs';

const runFile = promisify(execFile);

/** Queries the same helper that performs computer operations. Requests
 * consent only for an explicit settings action; a status read never prompts. */
export function createMacosComputerPermissions({ target = `${process.platform}-${process.arch}`,
  hostEntrypoint, run = runFile, enabledByEnvironment = process.env.TRYLO_MACOS_COMPUTER_USE === '1' } = {}) {
  return async (params = {}) => {
    if (target !== 'darwin-arm64') throw new Error('macOS computer permissions require Apple Silicon');
    if (params.request !== undefined && !['accessibility', 'screen'].includes(params.request)) {
      throw new Error('Unknown macOS computer permission request');
    }
    const { stdout } = await run(macosComputerExecutable(hostEntrypoint),
      ['--permissions', ...(params.request ? [params.request] : [])],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
    const value = JSON.parse(stdout);
    for (const key of ['accessibility', 'postEvents', 'screenRecording']) {
      if (typeof value[key] !== 'boolean') throw new Error(`Missing macOS permission state: ${key}`);
    }
    return { accessibility: value.accessibility, postEvents: value.postEvents,
      screenRecording: value.screenRecording, enabledByEnvironment };
  };
}
