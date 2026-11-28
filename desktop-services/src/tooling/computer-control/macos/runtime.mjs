import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACOS_COMPUTER_EXECUTABLE } from '../../macos-computer-contract.mjs';

export function macosComputerExecutable(hostEntrypoint = fileURLToPath(new URL('../../../host.mjs', import.meta.url))) {
  const hostDir = path.dirname(hostEntrypoint);
  const servicesDir = path.basename(hostEntrypoint) === 'host.bundle.mjs'
    ? path.resolve(hostDir, '..')
    : fileURLToPath(new URL('../../../../../desktop/src-tauri/resources/desktop-services/', import.meta.url));
  return path.join(servicesDir, MACOS_COMPUTER_EXECUTABLE);
}
