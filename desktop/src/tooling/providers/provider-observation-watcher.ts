// Trylo Desktop — provider observe/verify event watchers (WCC-P2-03 第二批).
//
// Host-side wiring for the DesktopActionProvider contract: these watchers
// turn the EXISTING `mcp__trylo-chrome__*` tool stream into provider
// observation + verification evidence. They mirror the
// `createSensitiveWindowWatcher` shape exactly — a bounded in-flight
// toolCallId tracker, fed from App.tsx's Work `onEvents` entries BEFORE the
// batch is projected.
//
// Division of labor (handoff doc §2 摸底结论 2): the MCP call chain is
// 模型→CLI→server. The host NEVER dispatches an MCP call on the model's
// behalf; the model sends its own pinned CDP calls through the existing
// classifier+approval flow. The provider layer only:
//   - OBSERVES  — when a CDP result confirms a browser is live, the routed
//     provider's capabilities are surfaced ("应用级动作可用");
//   - VERIFIES  — a finished CDP result feeds the routed provider's verify()
//     and the returned evidence (verifier/predicate/observed) is appended
//     to a bounded evidence buffer (SafeAudit posture: structural facts
//     only, never page bodies, URLs or user content).
//
// Routing never bypasses ToolRiskRouter approval: these watchers are
// read-only observers of results that ALREADY went through classification.

import type { LoopEvent, ToolResultEvent, ToolUseEvent } from '../../host-adapter/loop-events'
import type {
  AppIdentity,
  ProviderObservation,
  ProviderVerificationEvidence,
} from './provider-contract'
import { createProviderRegistry, type ProviderRegistry } from './provider-registry'

/** The MCP server prefix the browser CDP provider routes to. Any tool the
 *  registry's providers name in their ActionDescriptors is observed; today
 *  that is exactly `trylo-chrome`. */
export const CDP_MCP_PREFIX = 'mcp__trylo-chrome__'

/** Bounded in-flight tracker: toolCallIds of THIS conversation's CDP calls,
 *  so a result arriving in a LATER event batch can still be attributed
 *  (same trade-off as the sensitive-window watcher's pending map). */
const WATCHER_PENDING_LIMIT = 64

/** Bounded evidence/observation buffers, oldest evicted first. Everything
 *  kept here must stay diagnostics-safe (no page bodies, no URLs). */
const EVIDENCE_LIMIT = 64
const OBSERVATION_LIMIT = 16

/** One CDP tool → provider routing fact, derived from the provider's own
 *  capability table. Structure only — no user content. */
export interface ProviderRoutingFact {
  readonly providerId: string
  readonly mcpToolName: string
  readonly actionId: string
}

/** Map a pinned CDP MCP tool name back onto the routed provider's action id.
 *  A tool no capability names yields no fact (fail-closed: unknown CDP tools
 *  are simply not attributed). */
export function routingFactForMcpTool(
  registry: ProviderRegistry,
  mcpToolName: string,
): ProviderRoutingFact | null {
  for (const provider of registry.list()) {
    for (const capability of provider.capabilities()) {
      if (capability.mcpToolName === mcpToolName) {
        return { providerId: provider.id, mcpToolName, actionId: capability.actionId }
      }
    }
  }
  return null
}

/** Static lookup registry for UI helpers (cheap: one map, one provider). */
let routingLookup: ProviderRegistry | null = null
function routingLookupRegistry(): ProviderRegistry {
  if (routingLookup === null) routingLookup = createProviderRegistry()
  return routingLookup
}

/** Pure UI helper: the provider id whose capability table pins this MCP
 *  tool, or null when the tool belongs to no provider. ToolCard uses this
 *  to show 「应用级路由：browser-cdp provider」 — display only. */
export function providerRoutingLabelForTool(tool: string): string | null {
  return routingFactForMcpTool(routingLookupRegistry(), tool)?.providerId ?? null
}

/** A finished CDP invocation's verification outcome. Safe to keep: the
 *  evidence fields are provider-authored structural summaries; `ok` is the
 *  transport-level result flag. */
export interface ProviderVerifyRecord {
  readonly toolCallId: string
  readonly conversationId: string
  readonly mcpToolName: string
  readonly routedTo: string | null
  readonly actionId: string
  readonly ok: boolean
  readonly evidence: ProviderVerificationEvidence
}

/** What one event batch yielded, for tests and optional logging. */
export interface ProviderWatchOutcome {
  /** Observation when the batch finished a CDP call successfully. */
  readonly observation: ProviderObservation | null
  /** Verification evidence produced by the finished CDP results. */
  readonly verifications: readonly ProviderVerifyRecord[]
  /** Routing fact for each finished CDP result ("which provider owns this
   *  tool") — pinned routing attribution, display only. */
  readonly routings: readonly ProviderRoutingFact[]
}

/**
 * The AppIdentity a finished CDP call implies. The model's own browser-debug
 * call proves a Chromium-class browser is present — nothing more. The vendor
 * stays `unknown` because no window receipt title or process name arrives on
 * the CDP path today; a `likely` (not `exact`) match is the honest
 * confidence level and the provider surfaces a matching warning.
 */
export function identityFromCdpResult(): AppIdentity {
  return {
    appClass: 'browser',
    browser: { vendor: 'unknown' },
  }
}

/** Extract text blocks from a tool result event (output + text content),
 *  joined. Same shape-sensitive join the sensitive-window watcher uses;
 *  only text is interpreted and the text NEVER leaves verify() — the
 *  provider turns it into a structural predicate at most. */
function resultTextOf(result: ToolResultEvent): string {
  const blocks = (result.content ?? []).map((block) =>
    block.type === 'text' && typeof block.text === 'string' ? block.text : '',
  )
  return [result.output ?? '', ...blocks].join('\n')
}

export interface ProviderObservationWatcherOptions {
  /** Called for every verification record appended (App may ignore; a
   *  throwing callback is contained and never breaks the event stream). */
  readonly onVerifyRecord?: (record: ProviderVerifyRecord) => void
}

export interface ProviderObservationWatcher {
  /** Ingest one event batch. Asynchronous because provider.verify() is —
   *  App fire-and-forgets it (`void …ingest(…)`) exactly like the
   *  sensitive-window watcher's optional return value. */
  ingest(events: readonly LoopEvent[], conversationId: string): Promise<ProviderWatchOutcome>
  /** Bounded, diagnostics-safe verification evidence (SafeAudit posture). */
  recentEvidence(): readonly ProviderVerifyRecord[]
  /** Bounded, diagnostics-safe observations (capability names only). */
  recentObservations(): readonly ProviderObservation[]
}

/**
 * Build the provider observe/verify watcher over a registry. One instance
 * for the app lifetime (App.tsx useRef), fed from the Work onEvents
 * entries — the only surfaces whose Profiles can activate the browser-debug
 * package, exactly like the sensitive-window watcher's wiring.
 */
export function createProviderObservationWatcher(
  registry: ProviderRegistry,
  options: ProviderObservationWatcherOptions = {},
): ProviderObservationWatcher {
  const pending = new Map<string, string>()
  const evidence: ProviderVerifyRecord[] = []
  const observations: ProviderObservation[] = []

  async function ingest(
    events: readonly LoopEvent[],
    conversationId: string,
  ): Promise<ProviderWatchOutcome> {
    // The whole loop runs inside this try: App fire-and-forgets the promise
    // (`void ingest(...)`), so ANY rejection here would surface as an
    // unhandled promise rejection. Contain everything — a broken watcher
    // removes a diagnostics signal, never a run (§4.4).
    try {
      return await ingestInner(events, conversationId)
    } catch {
      return { observation: null, verifications: [], routings: [] }
    }
  }

  async function ingestInner(
    events: readonly LoopEvent[],
    conversationId: string,
  ): Promise<ProviderWatchOutcome> {
    let observation: ProviderObservation | null = null
    const verifications: ProviderVerifyRecord[] = []
    const routings: ProviderRoutingFact[] = []
    for (const event of events) {
      if (event.type === 'tool_use') {
        const use = event as ToolUseEvent
        if (use.tool.startsWith(CDP_MCP_PREFIX)) {
          pending.set(use.id, use.tool)
          if (pending.size > WATCHER_PENDING_LIMIT) {
            const oldest = pending.keys().next().value
            if (oldest !== undefined) pending.delete(oldest)
          }
        }
        continue
      }
      if (event.type !== 'tool_result') continue
      const result = event as ToolResultEvent
      const tool = pending.get(result.id)
      if (tool === undefined) continue
      pending.delete(result.id)
      // Routing fact first: pinned attribution straight from the capability
      // table. A tool no capability names stays unattributed (fail-closed).
      const fact = routingFactForMcpTool(registry, tool)
      if (fact !== null) routings.push(fact)
      const identity = identityFromCdpResult()
      const routed = registry.route(identity)
      if (routed === null) continue
      // OBSERVE: the first finished CDP call proves the application-level
      // surface is live — surface the routed provider's capabilities once.
      if (observation === null) {
        observation = {
          providerId: routed.provider.id,
          matched: true,
          availableActions: routed.provider.capabilities(),
          warnings: [
            `observed via ${tool} results; identity is class-level (browser), vendor unknown`,
          ],
        }
        observations.push(observation)
        if (observations.length > OBSERVATION_LIMIT) observations.shift()
      }
      // VERIFY: feed the result text as post-state. The provider's verify()
      // is honest by construction — it only confirms on machine-checkable
      // predicates and otherwise reports "stays unknown". A broken/throwing
      // provider must never break the event stream.
      try {
        const text = resultTextOf(result)
        const evidenceRecord = await registry.verify(identity, {
          actionId: fact?.actionId ?? tool,
          mcpToolName: tool,
          input: {},
          ...(text.length > 0 ? { postState: { ok: result.ok, text } } : {}),
        })
        const record: ProviderVerifyRecord = {
          toolCallId: result.id,
          conversationId,
          mcpToolName: tool,
          routedTo: fact?.providerId ?? null,
          actionId: fact?.actionId ?? tool,
          ok: result.ok,
          evidence: evidenceRecord,
        }
        evidence.push(record)
        if (evidence.length > EVIDENCE_LIMIT) evidence.shift()
        verifications.push(record)
        if (options.onVerifyRecord) {
          try {
            options.onVerifyRecord(record)
          } catch {
            /* a broken evidence sink must never break the event stream */
          }
        }
      } catch {
        /* contained: no evidence for this result, stream unaffected */
      }
    }
    return { observation, verifications, routings }
  }

  return {
    ingest,
    recentEvidence: () => [...evidence],
    recentObservations: () => [...observations],
  }
}
