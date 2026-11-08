import { createHash } from "node:crypto";
import { providerContinuationScope, type ProviderOutboundToolCall } from "../../ports/provider.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { isTranscriptItem } from "../../protocol/transcript.js";

export const MAX_REASONING_CHARS = 262_144;
const MAX_CHECKPOINT_CHARS = 1_048_576;
/** The only version this build writes. Version 1 stays readable for old journals. */
export const NATIVE_CHECKPOINT_VERSION = 2;

export type NativeAssistant = {
  readonly reasoning: string;
  readonly text: string;
  readonly calls: ReadonlyArray<ProviderOutboundToolCall>;
};

/** The response identity a checkpoint is matched by, without any native body. */
export type NativeIdentity = {
  readonly text: string;
  readonly calls: ReadonlyArray<ProviderOutboundToolCall>;
};

/**
 * What the journal knows about one assistant occurrence's native state.
 *
 * `absent` is the state that used to be lost: a complete response the provider
 * answered without any native continuation field. It is *evidence of nothing
 * to restore*, so a later process must not count it as a loss.
 *
 * All three states keep the response identity (`text` + ordered calls), because
 * that is what a later request is matched against. A marker without an identity
 * could never be attributed to a message, so it would be indistinguishable from
 * "no record at all" — exactly the confusion this state machine exists to end.
 */
export type NativeCheckpointState =
  | { readonly kind: "native"; readonly assistant: NativeAssistant }
  | { readonly kind: "absent"; readonly identity: NativeIdentity }
  | { readonly kind: "rejected"; readonly cause: "capture_rejected"; readonly identity: NativeIdentity };

/** A checkpoint read either yields a state, or names why it could not. */
export type CheckpointRead =
  | { readonly ok: true; readonly key: string; readonly state: NativeCheckpointState }
  | {
      readonly ok: false;
      /** Available when the payload was structured enough to identify the response. */
      readonly key: string | undefined;
      readonly cause: "checkpoint_invalid" | "binding_mismatch";
    };

export function glmContinuationBinding(endpoint: string, model: string): string | undefined {
  // Official aliases select the model on Volcano's console. Opt into this
  // endpoint's native reasoning_content contract, without rewriting the alias
  // to a permanently assumed concrete model. Only received native data is kept.
  if (!["ark-code-latest", "glm-latest", "glm-5.3", "glm-5-3",
    "glm-5.3-flash", "glm-5-3-flash", "glm-5-3-flash-260828"].includes(model.toLowerCase())) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.hostname !== "ark.cn-beijing.volces.com"
      || url.pathname.replace(/\/$/, "") !== "/api/coding/v3/chat/completions") return undefined;
    // Hash the complete endpoint rather than persisting possible URL secrets.
    return createHash("sha256").update(JSON.stringify([url.href, model])).digest("hex");
  } catch {
    // An invalid endpoint has no identity and cannot retain native state.
    return undefined;
  }
}

/**
 * The identity a checkpoint is matched by: the answer's text plus its ordered
 * tool calls. Tool ids alone are not identity — providers reuse them across
 * responses, so pairing by id would attach another response's reasoning.
 */
export function assistantKey(text: string, calls: ReadonlyArray<ProviderOutboundToolCall>): string {
  const original = calls.map(call => ({ toolCallId: call.toolCallId, name: call.name,
    arguments: call.originalArguments ?? call.arguments }));
  return createHash("sha256").update(JSON.stringify([text, original])).digest("hex");
}

function object(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: JsonObject, keys: ReadonlyArray<string>): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

/**
 * Serialize one checkpoint. Only version 2 is written:
 *
 *  - `native`  — the provider sent native fields and they are complete;
 *  - `absent`  — the response completed without them (this provider path does
 *                not carry them, or this response omitted them);
 *  - `rejected`— native fields existed but could not be kept (redacted,
 *                truncated, oversized, interrupted).
 *
 * `absent` and `rejected` are records *about* native state, not native state.
 * Without them a later process can only see "no checkpoint", which is exactly
 * how a non-event became a reported loss.
 */
export function glmCheckpoint(
  binding: string,
  scope: string,
  state: NativeCheckpointState,
): JsonObject | undefined {
  const version = NATIVE_CHECKPOINT_VERSION;
  const value: JsonObject = state.kind === "native"
    ? { version, binding, scope, state: "native",
        assistant: { reasoning: state.assistant.reasoning, text: state.assistant.text,
          calls: callsOf(state.assistant.calls) } }
    : state.kind === "absent"
      ? { version, binding, scope, state: "absent", identity: identityOf(state.identity) }
      : { version, binding, scope, state: "rejected", cause: state.cause,
          identity: identityOf(state.identity) };

  return JSON.stringify(value).length <= MAX_CHECKPOINT_CHARS ? value : undefined;
}

function callsOf(calls: ReadonlyArray<ProviderOutboundToolCall>): ReadonlyArray<JsonObject> {
  return calls.map(call => ({ toolCallId: call.toolCallId, name: call.name, arguments: call.arguments }));
}

function identityOf(identity: NativeIdentity): JsonObject {
  return { text: identity.text, calls: callsOf(identity.calls) };
}

/**
 * Read one journal record's native checkpoint.
 *
 * The failure cause is returned rather than swallowed: the adapter needs it to
 * tell "this response never had native data" from "its data is unusable now".
 * Old/foreign/partial state is never reconstructed from display reasoning; the
 * session loader checks journal integrity, this boundary checks the native
 * payload and the originating session/turn independently.
 */
type CheckpointRecord = Pick<SessionRecord, "type" | "sessionId" | "turnId" | "payload">;

export function readGlmCheckpoint(record: CheckpointRecord, sessionId: string, binding: string): CheckpointRead {
  if (record.sessionId !== sessionId || record.turnId === undefined || record.type !== "envelope") {
    return { ok: false, key: undefined, cause: "checkpoint_invalid" };
  }

  const envelope = record.payload["envelope"], value = record.payload["providerContinuation"];
  if (!object(envelope) || envelope["kind"] !== "stream_end" || !object(value)) {
    return { ok: false, key: undefined, cause: "checkpoint_invalid" };
  }

  if (value["scope"] !== providerContinuationScope(record.sessionId, record.turnId)) {
    return { ok: false, key: undefined, cause: "binding_mismatch" };
  }

  const version = value["version"];
  if (version !== 1 && version !== NATIVE_CHECKPOINT_VERSION) {
    return { ok: false, key: undefined, cause: "checkpoint_invalid" };
  }

  if (value["binding"] !== binding) {
    return { ok: false, key: keyOfPayload(value), cause: "binding_mismatch" };
  }

  if (JSON.stringify(value).length > MAX_CHECKPOINT_CHARS) {
    return { ok: false, key: undefined, cause: "checkpoint_invalid" };
  }

  return version === 1 ? readV1(value) : readV2(value);
}

/** A native fork is the sole authority to transfer a verified source scope.
 * Native body, version and binding remain untouched. The destination adapter
 * must still validate that binding against its own actual connection. */
export function forkGlmCheckpoint(
  record: CheckpointRecord,
  parentSessionId: string,
  childSessionId: string,
): { readonly ok: true; readonly checkpoint: JsonObject; readonly state: NativeCheckpointState["kind"] }
  | Extract<CheckpointRead, { readonly ok: false }> {
  if (record.sessionId !== childSessionId) return { ok: false, key: undefined, cause: "binding_mismatch" };

  const value = record.payload["providerContinuation"];
  if (!object(value) || typeof value["binding"] !== "string" || value["binding"].length === 0) return invalidRead();

  const source = readGlmCheckpoint({ ...record, sessionId: parentSessionId }, parentSessionId, value["binding"]);
  if (!source.ok) return source;

  const checkpoint = { ...value, scope: providerContinuationScope(childSessionId, record.turnId) };
  const target = readGlmCheckpoint({ ...record, payload: { ...record.payload, providerContinuation: checkpoint } }, childSessionId, value["binding"]);
  if (!target.ok) return target;

  return { ok: true, checkpoint, state: source.state.kind };
}

/** Version 1 had no state: a readable payload always meant full native data. */
function readV1(value: JsonObject): CheckpointRead {
  if (!sameKeys(value, ["assistant", "binding", "scope", "version"])) return invalidRead();
  const assistant = nativeAssistantOf(value["assistant"]);
  return assistant === undefined
    ? invalidRead()
    : { ok: true, key: assistantKey(assistant.text, assistant.calls), state: { kind: "native", assistant } };
}

function readV2(value: JsonObject): CheckpointRead {
  const state = value["state"];
  if (state === "absent") {
    if (!sameKeys(value, ["binding", "identity", "scope", "state", "version"])) return invalidRead();
    const identity = identityOfPayload(value["identity"]);
    return identity === undefined
      ? invalidRead()
      : { ok: true, key: assistantKey(identity.text, identity.calls), state: { kind: "absent", identity } };
  }

  if (state === "rejected") {
    if (!sameKeys(value, ["binding", "cause", "identity", "scope", "state", "version"])
      || value["cause"] !== "capture_rejected") return invalidRead();

    const identity = identityOfPayload(value["identity"]);

    return identity === undefined
      ? invalidRead()
      : { ok: true, key: assistantKey(identity.text, identity.calls),
          state: { kind: "rejected", cause: "capture_rejected", identity } };
  }

  if (state !== "native" || !sameKeys(value, ["assistant", "binding", "scope", "state", "version"])) {
    return invalidRead();
  }

  const assistant = nativeAssistantOf(value["assistant"]);

  return assistant === undefined
    ? invalidRead()
    : { ok: true, key: assistantKey(assistant.text, assistant.calls), state: { kind: "native", assistant } };
}

function invalidRead(): Extract<CheckpointRead, { readonly ok: false }> {
  return { ok: false, key: undefined, cause: "checkpoint_invalid" };
}

/** Best-effort key for a payload we rejected: used only to name the failure. */
function keyOfPayload(value: JsonObject): string | undefined {
  const assistant = nativeAssistantOf(value["assistant"]);
  if (assistant !== undefined) return assistantKey(assistant.text, assistant.calls);
  const identity = identityOfPayload(value["identity"]);
  return identity === undefined ? undefined : assistantKey(identity.text, identity.calls);
}

function identityOfPayload(raw: JsonValue | undefined): NativeIdentity | undefined {
  if (!object(raw) || !sameKeys(raw, ["calls", "text"])) return undefined;
  const text = raw["text"];
  if (typeof text !== "string") return undefined;
  const calls = callsOfPayload(raw["calls"]);
  return calls === undefined ? undefined : { text, calls };
}

function callsOfPayload(raw: JsonValue | undefined): ProviderOutboundToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const calls: ProviderOutboundToolCall[] = [], ids = new Set<string>();

  for (const item of raw) {
    if (!object(item) || !sameKeys(item, ["arguments", "name", "toolCallId"])) return undefined;
    const candidate = { kind: "tool_call", sequence: 0, ...item };
    if (!isTranscriptItem(candidate) || candidate.kind !== "tool_call" || ids.has(candidate.toolCallId)) return undefined;
    ids.add(candidate.toolCallId);
    calls.push({ toolCallId: candidate.toolCallId, name: candidate.name, arguments: candidate.arguments });
  }

  return calls;
}

function nativeAssistantOf(raw: JsonValue | undefined): NativeAssistant | undefined {
  if (!object(raw) || !sameKeys(raw, ["calls", "reasoning", "text"])) return undefined;

  const reasoning = raw["reasoning"], text = raw["text"], rawCalls = raw["calls"];
  if (typeof reasoning !== "string" || reasoning.length === 0 || reasoning.length > MAX_REASONING_CHARS
    || typeof text !== "string" || !Array.isArray(rawCalls) || (rawCalls.length === 0 && text.length === 0)) {
    return undefined;
  }

  const calls: ProviderOutboundToolCall[] = [], ids = new Set<string>();

  for (const item of rawCalls) {
    if (!object(item) || !sameKeys(item, ["arguments", "name", "toolCallId"])) return undefined;
    const candidate = { kind: "tool_call", sequence: 0, ...item };
    if (!isTranscriptItem(candidate) || candidate.kind !== "tool_call" || ids.has(candidate.toolCallId)) return undefined;
    ids.add(candidate.toolCallId);
    calls.push({ toolCallId: candidate.toolCallId, name: candidate.name, arguments: candidate.arguments });
  }

  return { reasoning, text, calls };
}
