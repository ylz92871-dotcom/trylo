export type CliProbeFailureCode =
  'not_found' | 'timeout' | 'spawn_failed' | 'unrecognized' | 'incompatible'
export type CliRuntimeProbeResult =
  | {
      readonly ok: true
      readonly kind: 'trylo-v1'
      readonly version: string
      readonly evidence: string
      readonly supportedFlags?: readonly string[]
    }
  | { readonly ok: false; readonly code: CliProbeFailureCode; readonly detail: string }
