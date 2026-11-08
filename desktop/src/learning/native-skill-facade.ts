import { runCliCommand, type CliCommandInput } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from '../tool-learning/cli-status'
import type {
  LearningExplicitParams,
  LearningPendingMutationResult,
  LearningSkillsResult,
  LearningReviewResult,
} from '../services-host/methods'
import type { LearningPort } from './learning-port'
import type { CentralLearningAllowance } from '../../../new trylo cli/src/internal/learning/control/coordination-contract'

type Row = Record<string, unknown>
const row = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const rows = (value: unknown): value is Row[] => Array.isArray(value) && value.every(row)
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const identifiers = (value: unknown): value is string[] => Array.isArray(value) && value.every(identifier)
const envelope = (value: Row) => value.schemaVersion === 1 && value.subsystem === 'skill'
const centralPending = (value: unknown): value is { readonly subsystem: 'skills'; readonly id: string } =>
  row(value) && value.subsystem === 'skills' && identifier(value.id) && value.id.length <= 512
function centralSkillReply(body: Row): LearningReviewResult {
  const hasPending = Object.hasOwn(body, 'pending')
  if (body.schemaVersion !== 1 || body.domain !== 'central'
    || !['completed', 'waiting', 'failed', 'cancelled'].includes(String(body.status))
    || hasPending && (!Array.isArray(body.pending) || body.pending.length > 32 || !body.pending.every(centralPending))) {
    return { ok: false, status: body.error === 'cancelled' ? 'cancelled' : 'failed',
      reason: identifier(body.error) ? body.error : 'central_skill_response_invalid' }
  }
  const result = row(body.result) ? body.result : undefined
  const dispatch = row(result?.result) ? result.result : undefined
  const work = row(dispatch?.result) ? dispatch.result : undefined
  const pendingIds = Array.isArray(body.pending) ? body.pending.filter(centralPending).map(item => item.id) : []
  // An explicit list is the current native projection. In particular, [] may
  // mean the historical proposal was already applied; never resurrect it.
  if (!hasPending && dispatch?.ok === true && work !== undefined
    && ['completed', 'failed', 'cancelled'].includes(String(work.kind)) && identifiers(work.resultRefs)) {
    pendingIds.push(...work.resultRefs.filter(ref => ref.startsWith('hermes-pending:skills:'))
      .map(ref => ref.slice('hermes-pending:skills:'.length)).filter(identifier))
  }
  const ids = [...new Set(pendingIds)]
  const pending = ids.length === 0 ? {} : { pendingId: ids[0], pendingIds: ids }
  if (body.status === 'failed' || body.status === 'cancelled') return { ok: false, status: body.status,
    reason: identifier(body.reason) ? body.reason : 'central_skill_execution_unconfirmed', ...pending }
  if (ids.length > 0) return { ok: true, status: 'staged', ...pending }
  if (body.reason === 'central_skill_already_applied') return { ok: true, status: 'completed', reason: body.reason }
  if (body.reason === 'central_learning_no_new_investment') return { ok: true, status: 'no_learning', reason: body.reason }
  if (row(result?.observation) && result.observation.outcome === 'closed_no_result') return { ok: true, status: 'no_learning' }
  return { ok: true, status: 'waiting', reason: identifier(body.reason) ? body.reason : 'central_skill_waiting' }
}
function explicitReply(value: Row): boolean {
  if (!envelope(value) || !['completed', 'waiting', 'disabled', 'cancelled', 'failed'].includes(String(value.status))) return false
  if (!row(value.usage) || !Number.isSafeInteger(value.usage.calls) || Number(value.usage.calls) < 0
    || !['reported', 'missing'].includes(String(value.usage.usageStatus))) return false
  if (value.status === 'completed' && (!row(value.legacyReply)
    || !['staged', 'no_learning', 'skipped'].includes(String(value.legacyReply.status)))) return false
  const native = value.legacyReply
  if (native !== undefined && (!row(native) || (native.pendingIds !== undefined && !identifiers(native.pendingIds))
    || (native.pendingId !== undefined && !identifier(native.pendingId)))) return false
  return !row(native) || native.status !== 'staged' || identifier(native.pendingId)
    || identifiers(native.pendingIds) && native.pendingIds.length > 0
}
type Options = {
  readonly runtime: () => ToolLearningRuntime
  readonly explicitAllowance: () => { readonly maxCalls: number; readonly maxOutputTokens: number }
  readonly centralAllowance?: () => CentralLearningAllowance | undefined
  readonly source: (
    params: LearningExplicitParams,
  ) => Promise<{ readonly sessionId: string; readonly turnId?: string } | undefined>
  readonly execute?: (input: CliCommandInput) => ReturnType<typeof runCliCommand>
}

/** Skill assets and learning use the CLI subsystem; Memory, mirror and maintenance retain their existing owner. */
export function createNativeSkillFacade(base: LearningPort, options: Options): LearningPort {
  const execute = options.execute ?? runCliCommand
  let explicitWorkspace: string | undefined
  const command = async (
    args: readonly string[],
    stdin?: string,
    timeoutMs = 45000,
    runtime: ToolLearningRuntime = options.runtime(),
  ): Promise<Row> => {
    try {
      const nativeHomeRequired = args[2] === 'native' || args[2] === 'explicit' || args[1] === 'central' && args[2] === 'skill'
      const health = nativeHomeRequired ? await base.health() : undefined
      if (nativeHomeRequired && !health?.storageRoot?.trim())
        return { ok: false, error: 'native_skill_storage_unavailable' }
      const result = await execute({
        ...runtime,
        ...(health?.storageRoot === undefined
          ? {}
          : { env: { TRYLO_HERMES_STORAGE_ROOT: health.storageRoot } }),
        args,
        ...(stdin === undefined ? {} : { stdin }),
        timeoutMs,
      })
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout ?? '')
      } catch {
        return { ok: false, error: !result.ok && result.reason === 'cancelled' ? 'cancelled' : 'native_skill_response_invalid' }
      }
      if (!result.ok) {
        // A nonzero CLI exit can still carry its confirmed partial proposals.
        // Only a formal failed/cancelled central envelope survives transport;
        // the domain decoder below validates every locator before displaying it.
        if (args[1] === 'central' && args[2] === 'skill' && row(parsed)
          && parsed.schemaVersion === 1 && parsed.domain === 'central'
          && (parsed.status === 'failed' || parsed.status === 'cancelled')) return parsed
        return {
          ok: false,
          error:
            result.reason === 'cancelled' ? 'cancelled' : row(parsed) && typeof parsed.reason === 'string'
              ? parsed.reason
              : 'native_skill_transport_failed',
        }
      }
      return row(parsed) ? parsed : { ok: false, error: 'native_skill_response_invalid' }
    } catch {
      return { ok: false, error: 'native_skill_transport_failed' }
    }
  }
  const native = async (method: string, params: object = {}): Promise<Row> => {
    const wire = await command(['learn', 'skill', 'native', method, '-'], JSON.stringify(params))
    return wire.schemaVersion === 1 &&
      wire.subsystem === 'skill' &&
      wire.method === method &&
      row(wire.body) &&
      typeof wire.body.ok === 'boolean'
      ? wire.body
      : {
          ok: false,
          error: typeof wire.error === 'string' ? wire.error : 'native_skill_response_invalid',
        }
  }
  const error = (body: Row): string | null =>
    typeof body.error === 'string'
      ? body.error
      : body.ok === true
        ? null
        : 'native_skill_operation_failed'
  const mutation = async (
    method: string,
    params: object,
  ): Promise<LearningPendingMutationResult> => {
    const body = await native(method, params)
    const result = body.result
    if (result !== undefined && result !== null && !row(result))
      return { ok: false, error: 'native_skill_response_invalid' }
    return {
      ok: body.ok === true,
      ...(result === undefined ? {} : { result }),
      error: error(body),
    }
  }
  return {
    ...base,
    async skills(params): Promise<LearningSkillsResult> {
      const body = await native('skillsQuery', params)
      if (
        body.ok === true &&
        (params.op === 'view' ? typeof body.content !== 'string' : !rows(body.skills))
      )
        return { ok: false, error: 'native_skill_response_invalid' }
      return {
        ...body,
        ok: body.ok === true,
        ...(error(body) === null ? {} : { error: error(body)! }),
      }
    },
    async listPending() {
      const [memory, skills] = await Promise.all([base.listPending(), native('pendingList')])
      const valid = skills.ok === true && rows(skills.pending)
      const pending = [
        ...memory.pending.filter((item) => item.subsystem === 'memory'),
        ...(valid && rows(skills.pending)
          ? skills.pending.filter((item) => item.subsystem === 'skills')
          : []),
      ]
      return {
        ok: memory.ok && valid,
        pending,
        count: pending.length,
        error: !valid
          ? (error(skills) ?? 'native_skill_response_invalid')
          : memory.ok
            ? null
            : (memory.error ?? 'memory_pending_unavailable'),
      }
    },
    async pendingDetail(params) {
      if (params.subsystem !== 'skills') return base.pendingDetail(params)
      const body = await native('pendingDetail', params)
      if (body.detail !== undefined && !row(body.detail))
        return { ok: false, error: 'native_skill_response_invalid' }
      return {
        ok: body.ok === true,
        ...(row(body.detail) ? { detail: body.detail } : {}),
        error: error(body),
      }
    },
    async applyPending(params) {
      if (params.subsystem !== 'skills') return base.applyPending(params)
      if (!params.id || !params.expectedHash)
        return { ok: false, error: 'pending_id_and_reviewed_hash_required' }
      return mutation('pendingApply', params)
    },
    async discardPending(params) {
      return params.subsystem === 'skills'
        ? mutation('pendingDiscard', params)
        : base.discardPending(params)
    },
    async listPendingBackups() {
      const body = await native('pendingBackupList')
      return {
        ok: body.ok === true && rows(body.backups),
        backups: rows(body.backups) ? body.backups : [],
        error: error(body),
      }
    },
    async rollbackPending(params) {
      return params.snapshotId
        ? mutation('pendingRollback', params)
        : { ok: false, error: 'snapshot_id_required' }
    },
    async reviewImplicit() {
      return {
        ok: false,
        status: 'skipped',
        reason: 'canonical_skill_learning_owned_by_task_runtime',
      }
    },
    async learnExplicit(params) {
      if (!params.learnRequest?.trim())
        return { ok: false, status: 'failed', reason: 'learn_request_required' }
      if (explicitWorkspace !== undefined)
        return { ok: false, status: 'skipped', reason: 'skill_explicit_request_in_progress' }
      const runtime = options.runtime()
      const centralAllowance = options.centralAllowance?.()
      let source: Awaited<ReturnType<Options['source']>>
      try {
        source = await options.source(params)
      } catch {
        return { ok: false, status: 'failed', reason: 'canonical_skill_source_unavailable' }
      }
      if (source === undefined)
        return { ok: false, status: 'failed', reason: 'canonical_skill_source_unavailable' }
      if (explicitWorkspace !== undefined)
        return { ok: false, status: 'skipped', reason: 'skill_explicit_request_in_progress' }
      // This is visibility of the owned transport, not a second persisted learning job or a success verdict.
      explicitWorkspace = params.workspaceRoot
      try {
        if (centralAllowance !== undefined) {
          const body = await command(['learn', 'central', 'skill', '-'], JSON.stringify({
            workspaceRoot: params.workspaceRoot, ...source, learnRequest: params.learnRequest,
            allowance: centralAllowance,
          }), 240000, runtime)
          return centralSkillReply(body)
        }
        const body = await command(
          ['learn', 'skill', 'explicit', '-'],
          JSON.stringify({
            workspaceRoot: params.workspaceRoot,
            ...source,
            learnRequest: params.learnRequest,
            allowance: options.explicitAllowance(),
          }),
          240000,
          runtime,
        )
        if (!explicitReply(body)) return { ok: false, status: body.error === 'cancelled' ? 'cancelled' : 'failed',
          reason: typeof body.error === 'string' ? body.error : 'native_skill_response_invalid' }
        const legacy = row(body.legacyReply) ? body.legacyReply : undefined
        const pendingIds = identifiers(legacy?.pendingIds) ? [...new Set(legacy.pendingIds)]
          : identifier(legacy?.pendingId) ? [legacy.pendingId] : []
        const status =
          typeof legacy?.status === 'string'
            ? legacy.status
            : typeof body.status === 'string'
              ? body.status
              : 'failed'
        return {
          ok: body.status === 'completed',
          status,
          ...(typeof legacy?.candidateId === 'string' ? { candidateId: legacy.candidateId } : {}),
          ...(pendingIds.length === 0 ? {} : { pendingId: pendingIds[0], pendingIds }),
          ...(typeof legacy?.reason === 'string'
            ? { reason: legacy.reason }
            : row(body.error) && identifier(body.error.code)
              ? { reason: body.error.code }
              : typeof body.reason === 'string'
                ? { reason: body.reason }
                : {}),
        }
      } finally {
        explicitWorkspace = undefined
      }
    },
    async runStatus(params = {}) {
      const scope = params.workspaceRoot ?? options.runtime().cwd
      if (scope === explicitWorkspace)
        return {
          ok: true,
          active: true,
          run: { workspace: scope, active: true, mode: 'skill_explicit', status: 'running' },
        }
      const body = await command(['learn', 'skill', 'issues', '--workspace', scope, '--json'])
      if (!envelope(body) || body.control !== 'issues' || body.ok !== true || !rows(body.jobs)
        || body.jobs.some(job => job.domain !== 'skill' || !identifier(job.jobId) || !identifier(job.state)))
        return { ok: false, active: false, run: null }
      const current = body.jobs.find((job) => job.state === 'running' || job.state === 'queued')
      return {
        ok: true,
        active: current !== undefined,
        run:
          current === undefined
            ? null
            : {
                workspace: scope,
                active: true,
                mode: 'skill',
                status: typeof current.state === 'string' ? current.state : 'unknown',
              },
      }
    },
  }
}
