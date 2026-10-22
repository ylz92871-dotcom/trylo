import { createHash } from "node:crypto";
import {
  providerContinuationScope,
  type NativeContinuationCause,
  type NativeContinuationDiagnostic,
  type ProviderContinuationPort,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderRequest,
} from "../../ports/provider.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import {
  glmCheckpoint,
  assistantKey,
  glmContinuationBinding,
  MAX_REASONING_CHARS,
  readGlmCheckpoint,
  type NativeAssistant,
  type NativeCheckpointState,
  type NativeIdentity,
} from "./glm-continuation-checkpoint.js";
import { createGlmContinuationCache } from "./glm-continuation-cache.js";

export type GlmToolContinuation = {
  /** Present only when this request degraded and the notice was not already delivered. */
  readonly diagnostic?: NativeContinuationDiagnostic;
  fieldsFor(message: ProviderMessage): { readonly reasoning_content?: string };
  observe(event: ProviderEvent): void;
  commit(): void;
};

type Capture =
  | { readonly kind: "collecting"; readonly assistant: NativeAssistant }
  | { readonly kind: "complete"; readonly assistant: NativeAssistant }
  /** The answer is complete and carried no native fields at all. */
  | { readonly kind: "absent"; readonly identity: NativeIdentity }
  /** Native fields were present but could not be kept (redacted/oversized/invalid). */
  | { readonly kind: "rejected"; readonly identity: NativeIdentity }
  /** The response never completed; there is no evidence native data ever existed. */
  | { readonly kind: "aborted" };

/** Per-message answer: either a journaled state, or the reason none was usable. */
type Origin =
  | { readonly kind: "state"; readonly state: NativeCheckpointState }
  | { readonly kind: "cause"; readonly cause: NativeContinuationCause };

const EMPTY: NativeAssistant = { reasoning: "", text: "", calls: [] };

function identityOf(assistant: NativeAssistant): NativeIdentity {
  return { text: assistant.text, calls: assistant.calls };
}

function advanceCapture(capture: Capture, event: ProviderEvent): Capture {
  if (capture.kind === "rejected") {
    if (event.type === "error" || event.type === "cancel_ack") return { kind: "aborted" };
    if (event.type === "text_delta") return { ...capture, identity: { ...capture.identity, text: capture.identity.text + event.text } };
    if (event.type === "tool_call") return { ...capture, identity: { ...capture.identity, calls: [...capture.identity.calls,
      { toolCallId: event.toolCallId, name: event.name, arguments: event.arguments }] } };
    return capture;
  }
  if (capture.kind !== "collecting") return capture;
  const assistant = capture.assistant;
  const rejectNative = (): Capture => ({ kind: "rejected", identity: identityOf(assistant) });
  if (event.type === "error" || event.type === "cancel_ack") return { kind: "aborted" };
  if (event.type === "tool_call_invalid") return rejectNative();
  if ((event.type === "reasoning_start" || event.type === "reasoning_delta") && event.redacted) return rejectNative();
  if (event.type === "reasoning_delta") {
    if (assistant.reasoning.length + event.text.length > MAX_REASONING_CHARS) return rejectNative();
    return { kind: "collecting", assistant: { ...assistant, reasoning: assistant.reasoning + event.text } };
  }
  if (event.type === "text_delta") return { kind: "collecting", assistant: { ...assistant, text: assistant.text + event.text } };
  if (event.type === "tool_call") return { kind: "collecting", assistant: { ...assistant, calls: [...assistant.calls,
    { toolCallId: event.toolCallId, name: event.name, arguments: event.arguments }] } };
  if (event.type !== "finish") return capture;
  const shaped = (event.reason === "tool_calls" && assistant.calls.length > 0)
    || (event.reason === "stop" && (assistant.calls.length > 0 || assistant.text.length > 0));
  if (!shaped) return { kind: "aborted" };
  // A complete answer without native fields is a *fact*, not a failure: the
  // provider path may not carry them at all, or this response omitted them.
  return assistant.reasoning.length > 0
    ? { kind: "complete", assistant }
    : { kind: "absent", identity: identityOf(assistant) };
}

/** Occurrence identity used for notice stability; never a tool id or a body. */
function messageKey(message: ProviderMessage): string {
  const calls = message.toolCalls ?? [];
  const original = calls.map(call => ({ toolCallId: call.toolCallId, name: call.name,
    arguments: call.originalArguments ?? call.arguments }));
  return createHash("sha256").update(JSON.stringify([message.content, original])).digest("hex");
}

function noticeIdOf(scope: string, cause: NativeContinuationCause, affected: ReadonlyArray<string>): string {
  let sessionScope = scope;
  try {
    const binding: unknown = JSON.parse(scope);
    if (Array.isArray(binding) && typeof binding[0] === "string") {
      const identity: unknown = JSON.parse(binding[0]);
      if (Array.isArray(identity) && typeof identity[0] === "string") sessionScope = JSON.stringify([identity[0], binding[1]]);
    }
  } catch {
    // Opaque caller scopes cannot be split safely; retain their full identity.
  }
  return createHash("sha256").update(JSON.stringify([sessionScope, cause, [...affected].sort()])).digest("hex");
}

/** The dominant cause: most occurrences first; the closed-set order breaks ties. */
function dominantCause(counts: ReadonlyMap<NativeContinuationCause, number>): NativeContinuationCause | undefined {
  let best: NativeContinuationCause | undefined, bestCount = 0;
  for (const [cause, count] of counts) {
    if (count > bestCount) { best = cause; bestCount = count; }
  }
  return best;
}

function diagnosticOf(
  scope: string,
  counts: ReadonlyMap<NativeContinuationCause, number>,
  affected: ReadonlyArray<string>,
): NativeContinuationDiagnostic | undefined {
  const cause = dominantCause(counts);
  if (cause === undefined) return undefined;
  let total = 0;
  for (const count of counts.values()) total += count;
  return {
    schemaVersion: 1, cause, affected: total,
    basis: "native_expected_occurrences", severity: "degraded",
    noticeId: noticeIdOf(scope, cause, affected),
  };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Notice ids already delivered, read back from this session's journal. */
function noticeIdsIn(record: SessionRecord): ReadonlyArray<string> {
  const envelope = record.payload["envelope"];
  if (!isObject(envelope) || envelope["kind"] !== "observation") return [];
  const payload = envelope["payload"];
  if (!isObject(payload)) return [];
  const diagnostic = payload["diagnostic"];
  if (!isObject(diagnostic) || typeof diagnostic["noticeId"] !== "string") return [];
  return [diagnostic["noticeId"]];
}

function stateOf(capture: Capture): NativeCheckpointState | undefined {
  if (capture.kind === "complete") return { kind: "native", assistant: capture.assistant };
  if (capture.kind === "absent") return { kind: "absent", identity: capture.identity };
  if (capture.kind === "rejected") return { kind: "rejected", cause: "capture_rejected", identity: capture.identity };
  return undefined;
}

/**
 * Native wire continuation, owned only by this adapter instance. It never
 * changes canonical transcript/display policy or reads reasoning from a caller.
 * Scope changes erase the cache; incomplete, redacted and oversized blocks are
 * rejected whole. Only explicitly restored, verified journal records may seed
 * a new turn; canonical display reasoning never seeds the native cache.
 *
 * Every assistant message is classified against the journal, not against the
 * cache alone: "the provider never sent native fields" and "we lost them" are
 * different answers, and only the second one is a degradation.
 */
export function createGlmToolContinuation(endpoint: string, configuredModel: string) {
  let activeScope: string | undefined;
  let generation = 0;
  const cache = createGlmContinuationCache();
  let checkpoint: { readonly scope: string; readonly value: JsonObject; readonly state: NativeCheckpointState; readonly binding: string } | undefined;
  let captureScope: string | undefined;
  /** Records the journal could not give us, keyed by occurrence identity. */
  const failed = new Map<string, NativeContinuationCause>();
  const evicted = new Set<string>();
  /** Survives scope changes: the same notice must not reappear on a new turn. */
  const delivered = new Set<string>();

  function clear(scope: string | undefined): void {
    cache.clear(); generation += 1; activeScope = scope; checkpoint = undefined;
    failed.clear(); evicted.clear();
  }

  const binding = glmContinuationBinding(endpoint, configuredModel);
  const persistence: ProviderContinuationPort | undefined = binding === undefined ? undefined : {
    bindCanonicalResponse(input) {
      if (checkpoint === undefined || input.scope !== captureScope || input.scope !== checkpoint.scope || input.message.role !== "assistant") return;
      const state = checkpoint.state, identity = state.kind === "native" ? state.assistant : state.identity;
      // Rewriters may project text, never invent another response's tool identity.
      if (assistantKey("", identity.calls) !== assistantKey("", input.message.toolCalls ?? [])) return;
      if (identity.text === input.message.content) return;
      const rebound: NativeCheckpointState = state.kind === "native"
        ? { kind: "native", assistant: { ...state.assistant, text: input.message.content } }
        : { ...state, identity: { ...state.identity, text: input.message.content } };
      const value = glmCheckpoint(checkpoint.binding, input.scope, rebound);
      if (value === undefined || !cache.replaceLast(state, rebound)) return;
      checkpoint = { ...checkpoint, value, state: rebound };
    },
    acknowledgeNotice(noticeId) { delivered.add(noticeId); },
    capture(scope) { return captureScope === scope && checkpoint?.scope === scope ? checkpoint.value : undefined; },
    estimateOverheadTokens: cache.estimateOverheadTokens,
    restore(input) {
      clear(JSON.stringify([providerContinuationScope(input.sessionId, input.turnId), configuredModel]));
      for (const record of input.records) {
        if (record.sessionId !== input.sessionId) continue;
        for (const id of noticeIdsIn(record)) delivered.add(id);
        const read = readGlmCheckpoint(record, input.sessionId, binding);
        if (!read.ok) {
          if (read.key !== undefined) failed.set(read.key, read.cause);
          continue;
        }
        for (const key of cache.retain(read.state)) evicted.add(key);
      }
    },
  };

  return {
    persistence,
    begin(request: ProviderRequest): GlmToolContinuation | undefined {
      const model = request.model || configuredModel;
      captureScope = request.continuationScope;
      const scope = request.continuationScope === undefined ? undefined : JSON.stringify([request.continuationScope, model]);
      const requestBinding = glmContinuationBinding(endpoint, model);
      if (scope === undefined || requestBinding === undefined) return undefined;
      // Auxiliary model-summary calls are unscoped; they must not evict the
      // paused parent's cache. They cannot read or retain native state.
      if (scope !== undefined && scope !== activeScope) clear(scope);
      checkpoint = undefined;
      generation += 1;
      const epoch = generation;
      const lookup = cache.matching(request.messages);
      const origins = new Map<ProviderMessage, Origin>();
      const counts = new Map<NativeContinuationCause, number>(), affected: string[] = [];
      for (const message of request.messages) {
        if (message.role !== "assistant") continue;
        const state = lookup.matched.get(message);
        if (state !== undefined) { origins.set(message, { kind: "state", state }); continue; }
        const key = messageKey(message);
        const cause = lookup.ambiguous.has(message) ? "history_mismatch"
          : failed.get(key) ?? (evicted.has(key) ? "cache_evicted" : undefined);
        // No cause and no state means the journal says nothing about this
        // occurrence. That is `unknown`, never a loss, so it is not counted.
        if (cause === undefined) continue;
        origins.set(message, { kind: "cause", cause });
        counts.set(cause, (counts.get(cause) ?? 0) + 1);
        affected.push(key);
      }
      const diagnostic = diagnosticOf(scope, counts, affected);
      const report = diagnostic === undefined || delivered.has(diagnostic.noticeId) ? undefined : diagnostic;
      let capture: Capture = { kind: "collecting", assistant: EMPTY };
      return {
        ...(report === undefined ? {} : { diagnostic: report }),
        fieldsFor(message) {
          const origin = origins.get(message);
          return origin !== undefined && origin.kind === "state" && origin.state.kind === "native"
            ? { reasoning_content: origin.state.assistant.reasoning } : {};
        },
        observe(event) { capture = advanceCapture(capture, event); },
        commit() {
          if (epoch !== generation) return;
          const state = stateOf(capture);
          if (state === undefined) return;
          for (const key of cache.retain(state)) evicted.add(key);
          const value = glmCheckpoint(requestBinding, request.continuationScope!, state);
          if (value !== undefined) { checkpoint = { scope: request.continuationScope!, value, state, binding: requestBinding }; captureScope = request.continuationScope; }
        },
      };
    },
  };
}
