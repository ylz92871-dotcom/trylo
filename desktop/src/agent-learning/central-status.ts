import { runCliCommand } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from '../tool-learning/cli-status'

type Resources = { readonly tokens: number; readonly calls: number; readonly steps: number }
export type CentralLearningStatus = {
  readonly scope: string
  readonly budget: null | { readonly budgetId: string; readonly limits: Resources; readonly occupied: Resources;
    readonly available: Resources; readonly status: 'available' | 'exhausted' | 'held'; readonly holdReason?: string }
  readonly issues: readonly { readonly issueId: string; readonly owner: string; readonly revision: number;
    readonly decision: string; readonly jobState?: string; readonly grantId?: string }[]
  readonly stages: readonly { readonly unitId: string; readonly stageRef: string; readonly criterion: string;
    readonly outcome: 'qualified' | 'closed_no_result' | 'pending'; readonly sourceRef: string; readonly sequence: number }[]
}
const row = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const keys = ['tokens', 'calls', 'steps'] as const
function resources(value: unknown, negative = false): value is Resources {
  return row(value) && Object.keys(value).length === 3 && keys.every(key =>
    typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (negative || Number(value[key]) >= 0))
}
function budget(value: unknown): value is CentralLearningStatus['budget'] {
  if (value === null) return true
  if (!row(value) || !identity(value.budgetId) || !['available', 'exhausted', 'held'].includes(String(value.status))
    || value.holdReason !== undefined && !identity(value.holdReason)) return false
  const limits = value.limits, occupied = value.occupied, available = value.available
  return resources(limits) && resources(occupied) && resources(available, true)
    && keys.every(key => available[key] === limits[key] - occupied[key])
}
function isStatus(value: unknown): value is CentralLearningStatus {
  return row(value) && value.schemaVersion === 1 && value.domain === 'central' && (value.ok === undefined || value.ok === true)
    && identity(value.scope) && budget(value.budget)
    && Array.isArray(value.issues) && value.issues.length <= 512 && value.issues.every(issue => row(issue)
      && identity(issue.issueId) && identity(issue.owner) && count(issue.revision) && identity(issue.decision)
      && (issue.jobState === undefined || identity(issue.jobState)) && (issue.grantId === undefined || identity(issue.grantId)))
    && Array.isArray(value.stages) && value.stages.length <= 512 && value.stages.every(stage => row(stage)
      && [stage.unitId, stage.stageRef, stage.criterion, stage.sourceRef].every(identity) && count(stage.sequence)
      && ['qualified', 'closed_no_result', 'pending'].includes(String(stage.outcome)))
}
export function parseCentralLearningStatus(stdout: string): CentralLearningStatus {
  if (stdout.length > 1048576) throw new Error('central_status_output_limit')
  let value: unknown
  try { value = JSON.parse(stdout) } catch { throw new Error('central_status_invalid_json') }
  if (!isStatus(value)) throw new Error('central_status_invalid_reply')
  return value
}
/** Read the canonical pool; this command cannot create/refill a budget. */
export async function readCentralLearningStatus(runtime: ToolLearningRuntime, signal: AbortSignal): Promise<CentralLearningStatus> {
  const result = await runCliCommand({ ...runtime, signal, args: ['learn', 'central', 'inspect', '-'],
    stdin: JSON.stringify({ workspaceRoot: runtime.cwd }) })
  if (!result.ok) throw new Error(result.reason)
  signal.throwIfAborted()
  return parseCentralLearningStatus(result.stdout)
}
