// Trylo Desktop — host-side §18.3 dispatch metrics (wrong-window slice).
//
// Spec §18.3 asks for `wrong_window_dispatch_count`; the fork declared it
// UNSOURCED (`runtime/metrics.py:_UNSOURCED_METRICS`) because the fork has
// no intent truth to compare against — the intent lives HERE, on the host.
// This module is the host-collected half of that metric:
//
//   tool_use event   input._target.window  → the INTENT receipt (the exact
//   window the server resolved the request to and the approval was shown
//   for — WCC-P2-01).
//   tool_result event  `trylo-target:{…}`  → the DISPATCH receipt (`window`)
//   plus `foregroundDigest` (what was foreground at dispatch — s19 schema).
//
//   wrong_window := both receipts exist AND their digests differ.
//
// Semantic decisions, explicit (execution-plan §5-1):
//  - Foreground jitter is NOT a wrong window. `foregroundDigest` is recorded
//    as a diagnostic only: dispatch targets a window by handle, so "another
//    window is foreground" is legal and counting it would over-report. The
//    counted predicate is the literal §18.4-1 sense — the dispatch LANDED on
//    a window other than the intended one.
//  - "Cannot judge" (no intent receipt on the input, or no fact block on the
//    result) is counted separately and NEVER folded into either side: an
//    unjudgeable dispatch is not a correct one (§18.3 honesty contract).
//  - The count lives in host-owned, in-memory aggregation — ZERO network,
//    no file writes. The §18.3 file sink belongs to the fork process; the
//    host never writes into it. A durable export face (diagnostics surface)
//    is the host-batch follow-up.

import type { LoopEvent, ToolResultEvent, ToolUseEvent } from '../host-adapter/loop-events'
import {
  TARGET_RECEIPT_INPUT_KEY,
  TARGET_RESULT_PREFIX,
  WINDOWS_SERVER_NAME,
  targetReceiptOf,
  targetResultFactsOf,
  type TargetResultFacts,
} from './classifiers/windows-mcp-classifier'

/** The §18.4-1 sense of wrong window: the dispatch receipt names a window
 *  other than the intent receipt. */
export type WrongWindowJudgement = {
  readonly verdict: 'wrong_window' | 'on_target'
  readonly intentDigest: string
  readonly dispatchDigest: string
  /** Diagnostic only (see module header) — never the counted predicate. */
  readonly foregroundDigest: string | null
}

export type UnjudgeableDispatch = {
  readonly verdict: 'unjudgeable'
  readonly reason: 'no_intent_receipt' | 'no_dispatch_facts'
}

export type DispatchJudgement = WrongWindowJudgement | UnjudgeableDispatch

/** Pure judge: compare the input's intent receipt against the result's
 *  dispatch facts. Total function — malformed or absent material yields an
 *  honest `unjudgeable`, never a guess. */
export function wrongWindowDispatchOf(
  input: Readonly<Record<string, unknown>> | undefined,
  facts: TargetResultFacts | null,
): DispatchJudgement {
  if (facts === null) return { verdict: 'unjudgeable', reason: 'no_dispatch_facts' }
  const intent = targetReceiptOf(input ?? {})
  if (intent === null) return { verdict: 'unjudgeable', reason: 'no_intent_receipt' }
  return {
    verdict: intent.digest === facts.window.digest ? 'on_target' : 'wrong_window',
    intentDigest: intent.digest,
    dispatchDigest: facts.window.digest,
    foregroundDigest: facts.foregroundDigest,
  }
}

/** Host-owned aggregation for the §18.3 counter (module header: memory only,
 *  zero network). Names mirror the fork's metric vocabulary so a future
 *  reconciliation reads 1:1. */
export interface DispatchMetricsSnapshot {
  /** §18.3 `wrong_window_dispatch_count`. */
  readonly wrongWindowDispatchCount: number
  /** Dispatches proven on-target (the denominator's honest half). */
  readonly onTargetDispatchCount: number
  /** Dispatches with no judgeable intent/dispatch pair — reported, never
   *  folded into the counted sides. */
  readonly unjudgeableDispatchCount: number
  /** §18.3 `unsafe_duplicate_count` (§18.4-3): re-submissions of a
   *  non-idempotent mutation while the prior same-target submission is
   *  still in flight OR finished with an unknown outcome. */
  readonly unsafeDuplicateCount: number
}

export class DesktopDispatchMetrics {
  private wrongWindow = 0
  private onTarget = 0
  private unjudgeable = 0
  private unsafeDuplicate = 0

  record(judgement: DispatchJudgement): void {
    if (judgement.verdict === 'wrong_window') this.wrongWindow += 1
    else if (judgement.verdict === 'on_target') this.onTarget += 1
    else this.unjudgeable += 1
  }

  recordUnsafeDuplicate(): void {
    this.unsafeDuplicate += 1
  }

  snapshot(): DispatchMetricsSnapshot {
    return {
      wrongWindowDispatchCount: this.wrongWindow,
      onTargetDispatchCount: this.onTarget,
      unjudgeableDispatchCount: this.unjudgeable,
      unsafeDuplicateCount: this.unsafeDuplicate,
    }
  }
}

/** Bounded in-flight tracker (same paradigm as createSensitiveWindowWatcher):
 *  toolCallId → the input's intent-bearing envelope, so a result arriving in
 *  a LATER event batch is still attributed. Oldest evicted first. */
const WATCHER_PENDING_LIMIT = 64

function resultFactsOf(result: ToolResultEvent): TargetResultFacts | null {
  const blocks = result.content ?? []
  const facts = targetResultFactsOf(blocks)
  if (facts !== null) return facts
  // Legacy emitters put everything in `output` — the fact block is located
  // by its marker prefix, so try the joined text before giving up.
  if (typeof result.output === 'string' && result.output.includes(TARGET_RESULT_PREFIX)) {
    return targetResultFactsOf([{ type: 'text', text: result.output }])
  }
  return null
}

export interface WrongWindowWatchOutcome {
  /** Whether this batch recorded any wrong-window dispatch (App may log;
   *  the count itself lives in the metrics store). */
  readonly wrongWindowRecorded: boolean
  /** Whether this batch recorded any unsafe duplicate submission (§18.4-3). */
  readonly unsafeDuplicateRecorded: boolean
  readonly judgements: readonly DispatchJudgement[]
}

// ── unsafe_duplicate (§18.4-3, host intent layer) ────────────────────

/** The windows tools whose repeated submission on an unknown outcome can
 *  leave unrecoverable state — the classifier's point-interaction and
 *  high-impact classes. Ambient tools (Move/Scroll/Wait/WaitFor) and screen
 *  reads are excluded: repeating them is recoverable or idempotent, so a
 *  duplicate is not UNSAFE. Clipboard counts only for `mode: "set"` (the
 *  destructive half — audit finding O-4). */
const UNSAFE_DUPLICATE_TOOLS = new Set<string>([
  'Click',
  'MultiSelect',
  'Type',
  'Shortcut',
  'App',
  'Clipboard',
])

const WINDOWS_TOOL_PREFIX = `mcp__${WINDOWS_SERVER_NAME}__`

function shortToolName(tool: string): string {
  return tool.slice(WINDOWS_TOOL_PREFIX.length)
}

function isUnsafeDuplicateCandidate(tool: string, input: Record<string, unknown>): boolean {
  if (!tool.startsWith(WINDOWS_TOOL_PREFIX)) return false
  const short = shortToolName(tool)
  if (!UNSAFE_DUPLICATE_TOOLS.has(short)) return false
  if (short === 'Clipboard' && input['mode'] !== 'set') return false
  return true
}

/** Stable comparison key for "the model is asking for the same thing
 *  again": conversation + tool + the sorted input (the `_target` envelope
 *  is replaced by its resolved digest so two envelopes for the SAME window
 *  compare equal while a stale receipt for another window does not). */
function duplicateKey(
  conversationId: string,
  tool: string,
  input: Record<string, unknown>,
  intentDigest: string | null,
): string {
  const rest: Record<string, unknown> = { ...input }
  delete rest[TARGET_RECEIPT_INPUT_KEY]
  const stable = JSON.stringify(rest, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      )
    }
    return value
  })
  return JSON.stringify([conversationId, tool, intentDigest, stable])
}

/** Bounded tracking for keys whose last mutation finished with an unknown
 *  outcome (LRU — a long session cannot grow this without bound). */
const UNKNOWN_OUTCOME_LIMIT = 64

/**
 * Event-pairing watcher over the windows-MCP tool stream. One instance for
 * the app lifetime (App.tsx useRef), fed from the Work onEvents entries at
 * the same point as the sensitive-window watcher. Read-only observer: it
 * never touches classification, approval, or the run itself.
 */
export function createWrongWindowDispatchWatcher(
  metrics: DesktopDispatchMetrics,
): (events: readonly LoopEvent[], conversationId: string) => WrongWindowWatchOutcome {
  const pending = new Map<string, Record<string, unknown>>()
  /** toolCallId → duplicate key, only for unsafe-duplicate candidates. */
  const pendingKeys = new Map<string, string>()
  /** Duplicate keys with a submission still in flight. */
  const inFlight = new Set<string>()
  /** Duplicate keys whose last mutation finished with an unknown outcome —
   *  the dangerous state §18.4-3 gates on. Bounded LRU. */
  const unknownOutcomes = new Set<string>()
  return (events, conversationId) => {
    const judgements: DispatchJudgement[] = []
    let unsafeDuplicateRecorded = false
    for (const event of events) {
      if (event.type === 'tool_use') {
        const use = event as ToolUseEvent
        if (use.tool.startsWith(WINDOWS_TOOL_PREFIX)) {
          const input = use.input ?? {}
          pending.set(use.id, input)
          if (pending.size > WATCHER_PENDING_LIMIT) {
            const oldest = pending.keys().next().value
            if (oldest !== undefined) pending.delete(oldest)
          }
          if (isUnsafeDuplicateCandidate(use.tool, input)) {
            const intent = targetReceiptOf(input)
            const key = duplicateKey(conversationId, use.tool, input, intent?.digest ?? null)
            if (inFlight.has(key) || unknownOutcomes.has(key)) {
              // §18.4-3: the same non-idempotent submission again while the
              // prior one is unresolved — count it, never block it (this
              // watcher is an observer; classification owns denial).
              metrics.recordUnsafeDuplicate()
              unsafeDuplicateRecorded = true
            }
            inFlight.add(key)
            pendingKeys.set(use.id, key)
            if (pendingKeys.size > WATCHER_PENDING_LIMIT) {
              const oldestKey = pendingKeys.keys().next().value
              if (oldestKey !== undefined) pendingKeys.delete(oldestKey)
            }
          }
        }
        continue
      }
      if (event.type !== 'tool_result') continue
      const result = event as ToolResultEvent
      const input = pending.get(result.id)
      if (input === undefined) continue
      pending.delete(result.id)
      const key = pendingKeys.get(result.id) ?? null
      pendingKeys.delete(result.id)
      const facts = resultFactsOf(result)
      const judgement = wrongWindowDispatchOf(input, facts)
      judgements.push(judgement)
      metrics.record(judgement)
      if (key !== null) {
        inFlight.delete(key)
        if (facts !== null) {
          const effect = facts.effect
          if (effect === undefined || effect === 'unknown_outcome') {
            // Unresolved mutation: a same-key resubmission is an unsafe
            // duplicate until a confirmed outcome arrives (LRU-bounded).
            unknownOutcomes.delete(key)
            unknownOutcomes.add(key)
            if (unknownOutcomes.size > UNKNOWN_OUTCOME_LIMIT) {
              const oldest = unknownOutcomes.values().next().value
              if (oldest !== undefined) unknownOutcomes.delete(oldest)
            }
          } else {
            unknownOutcomes.delete(key)
          }
        }
      }
    }
    return {
      wrongWindowRecorded: judgements.some((judgement) => judgement.verdict === 'wrong_window'),
      unsafeDuplicateRecorded,
      judgements,
    }
  }
}
