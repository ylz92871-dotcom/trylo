// Native resolution is the sole owner of the new CLI entry and its interpreter.
// It is launch-specific and never persisted into user preferences.

import type { CliRuntimeResolution } from '../host-adapter/cli-runtime-path'

let current: CliRuntimeResolution | null = null

/** Record this launch's resolution (called once at app startup). */
export function setCliRuntimeResolution(resolution: CliRuntimeResolution | null): void {
  current = resolution
}

/** This launch's resolution, or null before it is known / on failure. */
export function getCliRuntimeResolution(): CliRuntimeResolution | null {
  return current
}

/** Test seam: forget the cached resolution. */
export function resetCliRuntimeResolution(): void {
  current = null
}
