import type { StoredConversationResults } from '../results/conversation-result-types'
import type { RecoverableProcess } from '../host-adapter/process-service'
import {
  isConversationRecoveryIdentity,
  isTeamRecoveryIdentity,
} from '../host-adapter/process-recovery-identity'

export interface PersistedRecoveryRun {
  readonly runId: string
  readonly turnId: string
  /** Durable result receipt, not inferred from a final-looking assistant text. */
  readonly settled?: true
}

/** Read the existing result owner; a recovery observer never writes a second run record. */
export function persistedConversationRecoveryRun(
  results: StoredConversationResults | undefined,
): PersistedRecoveryRun | undefined {
  const candidates = [results?.code?.latestRun?.meta, results?.work?.latestRun]
    .filter((run): run is NonNullable<typeof run> => run !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt)
  const first = candidates[0]
  if (
    !first ||
    candidates.some(
      (run) =>
        run !== first &&
        run.startedAt === first.startedAt &&
        (run.runId !== first.runId || run.turnId !== first.turnId),
    )
  )
    return undefined
  const settled = first.finishedAt !== undefined && Number.isFinite(first.finishedAt)
    && ['completed', 'failed', 'cancelled'].includes(first.status)
  return { runId: first.runId, turnId: first.turnId, ...(settled ? { settled: true as const } : {}) }
}

export type OutputSelection =
  | { readonly kind: 'team'; readonly teamRunId: string }
  | {
      readonly kind: 'conversation'
      readonly turnIds: readonly string[]
      readonly expectedRun?: PersistedRecoveryRun
    }

export function matchesOutputSelection(
  process: RecoverableProcess,
  selection: OutputSelection,
): boolean {
  return selection.kind === 'team'
    ? isTeamRecoveryIdentity(process.identity) && process.identity.teamRunId === selection.teamRunId
    : isConversationRecoveryIdentity(process.identity)
}

/** Prefer a proven live root; otherwise use the latest human turn present in history. */
export function selectConversationOutput(
  candidates: readonly RecoverableProcess[],
  liveIds: ReadonlySet<string>,
  turnIds: readonly string[],
  expectedRun?: PersistedRecoveryRun,
): RecoverableProcess | null {
  const live = candidates.filter((process) => liveIds.has(process.id))
  if (live.length > 1) throw new Error('同一会话有多个原生执行，未自动选择，请先核对原执行。')
  if (live.length === 1) return live[0]!
  for (const turnId of [...turnIds].reverse()) {
    const matches = candidates.filter((process) => process.identity.turnId === turnId)
    if (matches.length > 1) {
      const recorded =
        expectedRun?.turnId === turnId
          ? matches.filter(
              (process) =>
                isConversationRecoveryIdentity(process.identity) &&
                process.identity.runId === expectedRun.runId,
            )
          : []
      if (recorded.length === 1) return recorded[0]!
      throw new Error('同一轮次有多个执行记录，未自动选择输出。')
    }
    if (matches.length === 1) return matches[0]!
  }
  if (candidates.length > 1) throw new Error('保留的输出缺少可核对的原始提问，未自动选择执行。')
  return candidates[0] ?? null
}
