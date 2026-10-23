// Trylo Desktop — which CLI runtime a Code run talks to (P08 §4.1).
//
// ONE extension point, and it must reach every boundary that decides
// how a process is spawned, shared or reused:
//
//   - persistent settings + migration
//   - the `SettingsForCodeRun` snapshot
//   - the runtime fingerprint
//   - the runner route
//   - the settings UI
//
// The product owner selected trylo-v1 for public source builds (2026-10-15).
// Legacy protocol adapters remain for explicitly configured external runtimes.

export type CliRuntimeProtocol = 'legacy-stream-json' | 'trylo-v1';

export const CLI_RUNTIME_PROTOCOLS: readonly CliRuntimeProtocol[] = [
  'legacy-stream-json',
  'trylo-v1',
];

/** Public source builds use the new CLI without a private development env file. */
export const DEFAULT_CLI_RUNTIME_PROTOCOL: CliRuntimeProtocol =
  parseCliRuntimeProtocol(import.meta.env.VITE_TRYLO_DEFAULT_CLI_RUNTIME) ?? 'trylo-v1';

/** Release capability, separate from the default so old stored selections migrate too. */
export function isNewCliOnlyDistribution(): boolean {
  return import.meta.env.VITE_TRYLO_NEW_CLI_ONLY === 'true';
}

export function parseCliRuntimeProtocol(value: unknown): CliRuntimeProtocol | null {
  return value === 'legacy-stream-json' || value === 'trylo-v1' ? value : null;
}

export function isCliRuntimeProtocol(value: unknown): value is CliRuntimeProtocol {
  return parseCliRuntimeProtocol(value) !== null;
}

/**
 * Capability matrix (P08 §3.3): `trylo-v1` is ONE PROCESS PER TURN.
 * Its stdin remains open for answers, queued guidance and cancellation
 * during that turn; idle process reuse and prewarming remain disabled.
 */
export interface CliRuntimeCapabilities {
  /** Reuse a live idle CLI for the next turn (legacy warm path). */
  readonly warmReuse: boolean;
  /** Spawn an idle CLI ahead of the first send. */
  readonly prewarm: boolean;
  /** Inject another user frame into a running turn. */
  readonly steering: boolean;
  /**
   * Bidirectional permission/control frames on the prompt stdin.
   * Desktop V1 runs use framed stdio at every permission level. Guidance
   * joins the current run at its next input boundary; no idle process remains.
   */
  readonly controlFrames: boolean;
}

const LEGACY_CAPABILITIES: CliRuntimeCapabilities = {
  warmReuse: true,
  prewarm: true,
  steering: true,
  controlFrames: true,
};

const V1_CAPABILITIES: CliRuntimeCapabilities = {
  warmReuse: false,
  prewarm: false,
  steering: true,
  controlFrames: true,
};

export function capabilitiesFor(protocol: CliRuntimeProtocol): CliRuntimeCapabilities {
  return protocol === 'trylo-v1' ? V1_CAPABILITIES : LEGACY_CAPABILITIES;
}

export function supportsWarmReuse(protocol: CliRuntimeProtocol): boolean {
  return capabilitiesFor(protocol).warmReuse;
}

export function supportsPrewarm(protocol: CliRuntimeProtocol): boolean {
  return capabilitiesFor(protocol).prewarm;
}

export function supportsSteering(protocol: CliRuntimeProtocol): boolean {
  return capabilitiesFor(protocol).steering;
}
