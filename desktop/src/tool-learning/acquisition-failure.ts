import { record, text } from './wire'

export type ToolAcquisitionFailureView = {
  readonly ref: string
  readonly phase: 'resolve' | 'preparation_permission' | 'preparation' | 'plan_commit' | 'install_permission' | 'install' | 'receipt_commit'
  readonly code: string
  readonly recovery: 'investigate' | 'retry_explicitly' | 'await_stop'
  readonly diagnostics: readonly { readonly packageName: string; readonly version?: string; readonly stage: 'metadata_fetch' | 'metadata_projection' | 'selected_archive_semantics'; readonly code: string }[]
}
const phases = new Set(['resolve', 'preparation_permission', 'preparation', 'plan_commit', 'install_permission', 'install', 'receipt_commit'])
const code = (raw: unknown): raw is string => typeof raw === 'string' && /^[a-z][a-z0-9_]{0,159}$/.test(raw)
export function acquisitionFailure(raw: unknown): raw is ToolAcquisitionFailureView {
  return record(raw) && typeof raw['ref'] === 'string' && /^tool-acquisition-failure_v1_[a-f0-9]{64}$/.test(raw['ref'])
    && typeof raw['phase'] === 'string' && phases.has(raw['phase']) && code(raw['code'])
    && ['investigate', 'retry_explicitly', 'await_stop'].includes(String(raw['recovery'])) && Array.isArray(raw['diagnostics']) && raw['diagnostics'].length <= 16
    && raw['diagnostics'].every(row => record(row) && text(row['packageName'], 256) && /^(?:@[a-z0-9][a-z0-9._-]{0,80}\/)?[a-z0-9][a-z0-9._-]{0,80}$/.test(row['packageName'])
      && (row['version'] === undefined || text(row['version'], 80) && /^[0-9A-Za-z.+-]+$/.test(row['version'])) && code(row['code'])
      && ['metadata_fetch', 'metadata_projection', 'selected_archive_semantics'].includes(String(row['stage'])))
}
export function copyAcquisitionFailure(raw: ToolAcquisitionFailureView): ToolAcquisitionFailureView {
  return { ref: raw.ref, phase: raw.phase, code: raw.code, recovery: raw.recovery, diagnostics: raw.diagnostics.map(row => ({
    packageName: row.packageName, stage: row.stage, code: row.code, ...(row.version === undefined ? {} : { version: row.version }) })) }
}
