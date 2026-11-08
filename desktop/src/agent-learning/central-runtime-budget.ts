import { runCliCommand } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from '../tool-learning/cli-status'

export type CentralBudgetResources = { readonly tokens: number; readonly calls: number; readonly steps: number }
export type CentralBudgetRootRef = { readonly budgetId: string; readonly scope: string; readonly openedSequence: number; readonly authorizationRef: string }
export type CentralBudgetSnapshot = {
  readonly rootRef: CentralBudgetRootRef
  readonly boardSequence: number
  readonly limits: CentralBudgetResources
  readonly occupied: CentralBudgetResources
  readonly available: CentralBudgetResources
  readonly status: 'available' | 'exhausted' | 'held'
  readonly holdReason?: string
}
export type CentralBudgetReply = {
  readonly enabled: boolean
  readonly budget: CentralBudgetSnapshot | null
  readonly mutation?: 'applied' | 'duplicate'
  readonly wake?: { readonly status: 'sent' | 'skipped' | 'unconfirmed'; readonly reason?: string }
}
export type CentralBudgetChange = { readonly rootRef: CentralBudgetRootRef; readonly expectedSequence: number;
  readonly changeId: string; readonly limits: CentralBudgetResources }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const sequence = (value: unknown): value is number => integer(value) && value >= 0
function resources(value: unknown, signed = false): value is CentralBudgetResources {
  return record(value) && ['tokens', 'calls', 'steps'].every(key => signed ? integer(value[key]) : sequence(value[key]))
}
function root(value: unknown): value is CentralBudgetRootRef {
  return record(value) && text(value.budgetId) && text(value.scope) && sequence(value.openedSequence) && value.openedSequence > 0 && text(value.authorizationRef)
}
function snapshot(value: unknown): value is CentralBudgetSnapshot {
  return record(value) && root(value.rootRef) && sequence(value.boardSequence) && resources(value.limits)
    && resources(value.occupied) && resources(value.available, true) && ['available', 'exhausted', 'held'].includes(String(value.status))
    && (value.holdReason === undefined || text(value.holdReason))
}

export class CentralBudgetCommandError extends Error {
  constructor(readonly reason: string, readonly outcome: 'rejected' | 'unknown') { super(reason); this.name = 'CentralBudgetCommandError' }
}
function commandFailure(reason: string): CentralBudgetCommandError {
  return new CentralBudgetCommandError(reason, reason === 'central_runtime_budget_unconfirmed'
    || reason === 'central_runtime_budget_readback_unconfirmed' ? 'unknown' : 'rejected')
}
export function parseCentralRuntimeBudget(stdout: string): CentralBudgetReply {
  if (stdout.length > 65536) throw new CentralBudgetCommandError('central_budget_output_limit', 'unknown')
  let value: unknown
  try { value = JSON.parse(stdout) } catch { throw new CentralBudgetCommandError('central_budget_reply_invalid', 'unknown') }
  if (!record(value) || value.schemaVersion !== 1 || value.domain !== 'central_runtime_budget') throw new CentralBudgetCommandError('central_budget_reply_invalid', 'unknown')
  if (value.ok === false && text(value.reason)) throw commandFailure(value.reason)
  if (value.ok !== true || typeof value.enabled !== 'boolean' || !(value.budget === null || snapshot(value.budget))
    || value.mutation !== undefined && value.mutation !== 'applied' && value.mutation !== 'duplicate') throw new CentralBudgetCommandError('central_budget_reply_invalid', 'unknown')
  let wake: CentralBudgetReply['wake']
  if (value.wake !== undefined) {
    if (!record(value.wake) || !['sent', 'skipped', 'unconfirmed'].includes(String(value.wake.status))
      || value.wake.reason !== undefined && !text(value.wake.reason)) throw new CentralBudgetCommandError('central_budget_reply_invalid', 'unknown')
    wake = { status: value.wake.status as NonNullable<CentralBudgetReply['wake']>['status'], ...(value.wake.reason === undefined ? {} : { reason: value.wake.reason as string }) }
  }
  return { enabled: value.enabled, budget: value.budget, ...(value.mutation === undefined ? {} : { mutation: value.mutation }), ...(wake === undefined ? {} : { wake }) }
}

async function command(runtime: ToolLearningRuntime, payload: object, signal?: AbortSignal): Promise<CentralBudgetReply> {
  const result = await runCliCommand({ ...runtime, args: ['learn', 'central', 'runtime', '-'], timeoutMs: 15000,
    stdin: JSON.stringify({ workspaceRoot: runtime.cwd, ...payload }), ...(signal === undefined ? {} : { signal }) })
  if (!result.ok) {
    if (result.stdout) {
      let parsed: unknown
      try { parsed = JSON.parse(result.stdout) } catch { /* An unconfirmed transport is handled below. */ }
      if (record(parsed) && parsed.schemaVersion === 1 && parsed.domain === 'central_runtime_budget' && parsed.ok === false && text(parsed.reason)) throw commandFailure(parsed.reason)
    }
    throw new CentralBudgetCommandError(result.reason, 'unknown')
  }
  signal?.throwIfAborted()
  return parseCentralRuntimeBudget(result.stdout)
}
export function readCentralRuntimeBudget(runtime: ToolLearningRuntime, signal?: AbortSignal): Promise<CentralBudgetReply> {
  return command(runtime, { action: 'budget_inspect' }, signal)
}
/** Explicit user management only. This is never attached to a model or worker funding port. */
export async function setCentralRuntimeBudgetLimits(runtime: ToolLearningRuntime, change: CentralBudgetChange, signal?: AbortSignal): Promise<CentralBudgetReply> {
  const result = await command(runtime, { action: 'budget_set_limits', ...change }, signal)
  const received = result.budget?.rootRef, expected = change.rootRef
  if (!result.mutation || !received || received.budgetId !== expected.budgetId || received.scope !== expected.scope
    || received.openedSequence !== expected.openedSequence || received.authorizationRef !== expected.authorizationRef) throw new CentralBudgetCommandError('central_budget_reply_binding', 'unknown')
  return result
}
