// Trylo Desktop — user-facing text for pet status (audit §4.2 PET-P0-1).
//
// The UI shows a FIXED string per reason code and NEVER the raw sidecar
// message: that message can carry a private absolute path, and the audit
// forbids private paths in renderer-facing diagnostics. Every code in
// `PetReasonCode` has an entry here; an unknown code falls back to a
// generic line rather than leaking.

import type { PetStatusSnapshot } from '../services-host/methods';

/** Short headline for the settings row / status chip. */
export function petStatusHeadline(status: PetStatusSnapshot): string {
  if (status.launched) return status.chatConnected ? 'Running' : 'Starting';
  if (!status.exeFound) return 'Not available';
  return 'Not running';
}

/** Actionable detail. Returns '' when everything is fine. */
export function petStatusDetail(status: PetStatusSnapshot): string {
  if (status.launched) {
    return status.chatConnected
      ? ''
      : 'The pet window is opening. If it does not appear, reopen the desktop chat.';
  }
  switch (status.reasonCode) {
    case 'exe_not_found':
      return 'TryloDesktopPet.exe was not found next to the app. Reinstall the desktop pet build.';
    case 'no_sidecars_dir':
      return 'The app could not locate its sidecar directory, so the pet cannot start.';
    case 'bridge_module_missing':
      return 'The companion bridge module is missing from the install. Repair the installation.';
    case 'spawn_failed':
    case 'spawn_no_pid':
      return 'The pet process could not be started. Check that Windows allows it to run.';
    case 'unsupported_platform':
      return 'The desktop pet is Windows-only.';
    case 'bridge_unavailable':
    case 'not_attempted':
    case '':
      return '';
    default:
      // Unknown code: say nothing specific rather than echoing a message
      // that may contain a private path.
      return 'The pet is not running.';
  }
}

/** Three-state tone used for the chip colour. */
export type PetStatusTone = 'ok' | 'pending' | 'error';

export function petStatusTone(status: PetStatusSnapshot): PetStatusTone {
  if (status.launched) return status.chatConnected ? 'ok' : 'pending';
  if (status.reasonCode === '' || status.reasonCode === 'not_attempted') return 'pending';
  return 'error';
}
