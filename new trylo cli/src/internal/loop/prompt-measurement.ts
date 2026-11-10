import { createHash } from "node:crypto";
import type { CompleteInputTokenObservation, ProviderMessage, ProviderNativeRequestIdentity, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { CompactionInput, CompactionWiring, ReportedRequestBasis } from "./compact-boundary.js";
import type { ToolPort } from "../ports/tools.js";
import { promptViewMessages } from "./prompt-view.js";
import { requestMessages, toolSpecs } from "./request.js";
import type { PersistablePromptInputIdentity } from "../ports/prompt-input.js";
import { evaluateStoredPromptInputBasis } from "./stored-prompt-budget.js";

export type PromptBudgetBasisReason = "no_report" | "measurement_unavailable" | "invalid_report" | "window_changed"
  | "tools_changed" | "native_unverifiable" | "native_changed" | "model_changed" | "request_settings_changed"
  | "history_changed" | "legacy_or_unknown_source" | "complete_prompt_preserved" | "unpriced_media"
  | "input_binding_unavailable" | "input_binding_changed";

/** One calculation owns admission and its observation. Only numbers, closed
 * source metadata and hashes cross into diagnostics; no request text does. */
export type PromptBudgetBasisDecision = {
  readonly basis: "local" | "legacy_max" | "server_plus_added";
  readonly tokens: number;
  readonly localEstimate: number;
  readonly reason: PromptBudgetBasisReason;
  readonly requestDigest: string;
  readonly observedInputTokens?: number;
  readonly addedTokens?: number;
  readonly inputTokenObservation?: CompleteInputTokenObservation;
  /** Automatic-maintenance estimate, distinct from the admission bound. */
  readonly automaticTokens?: number;
};

/** Identity of the actual request a provider measured, without retaining its text. */
export type PromptMeasurement = {
  readonly persistableInput?: PersistablePromptInputIdentity;
  readonly messageDigests: ReadonlyArray<string>;
  readonly toolDigest: string;
  /** Missing on legacy reports, which retain their conservative old path. */
  readonly model?: string;
  readonly settingsDigest?: string;
  readonly messageRoles?: ReadonlyArray<ProviderMessage["role"]>;
  /** Absent means no native owner; null means its actual input was unverifiable. */
  readonly nativeIdentity?: ProviderNativeRequestIdentity | null;
};

/** Capture before streaming: provider adapters cannot mutate the recorded identity. */
export function capturePromptMeasurement(request: ProviderRequest, nativeIdentity?: ProviderNativeRequestIdentity | null,
  persistableInput?: PersistablePromptInputIdentity): PromptMeasurement {
  return { messageDigests: request.messages.map(digestOf), toolDigest: digestOf(request.tools), model: request.model,
    settingsDigest: inputSettingsDigest(request), messageRoles: request.messages.map(message => message.role),
    ...(nativeIdentity === undefined ? {} : { nativeIdentity: copyNativeIdentity(nativeIdentity, request.messages.length) }),
    ...(persistableInput === undefined ? {} : { persistableInput: { ...persistableInput } }) };
}

/** A diagnostic seam cannot break a turn or expose the owner's private input. */
export function measureNativeRequestIdentity(provider: Pick<ProviderPort, "continuation">,
  request: ProviderRequest): ProviderNativeRequestIdentity | null | undefined {
  if (provider.continuation === undefined) return undefined;
  try { return copyNativeIdentity(provider.continuation.measureRequestIdentity?.(request), request.messages.length); }
  catch { return null; }
}

function copyNativeIdentity(value: unknown, length: number): ProviderNativeRequestIdentity | null {
  if (typeof value !== "object" || value === null || !("requestDigest" in value)
    || !("messageFieldDigests" in value) || !("messageOverheadTokens" in value)) return null;

  const { requestDigest, messageFieldDigests, messageOverheadTokens } = value;
  const isDigest = (digest: unknown): digest is string => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);
  if (!isDigest(requestDigest) || !Array.isArray(messageFieldDigests) || messageFieldDigests.length !== length
    || !Array.from(messageFieldDigests).every(isDigest) || !Array.isArray(messageOverheadTokens) || messageOverheadTokens.length !== length
    || !Array.from(messageOverheadTokens).every(tokens => typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0)) return null;

  return { requestDigest, messageFieldDigests: [...messageFieldDigests], messageOverheadTokens: [...messageOverheadTokens] };
}

/** Price native input in the same full-request occurrence lookup as the send.
 * Scope changes can remove cached fields; subset matching can also be ambiguous.
 * Without both verified identity and a text-only estimator, keep the old basis.
 */
export function localPreparedRequestTokens(request: ProviderRequest, wiring: CompactionWiring, tools: ToolPort,
  nativeIdentity?: ProviderNativeRequestIdentity | null): number {
  const native = nativeIdentity === undefined ? null : copyNativeIdentity(nativeIdentity, request.messages.length);
  const messages = native !== null && wiring.estimateTextPromptTokens !== undefined
    ? wiring.estimateTextPromptTokens(request.messages) + native.messageOverheadTokens.reduce((sum, tokens) => sum + tokens, 0)
    : wiring.estimatePromptTokens(request.messages);
  return messages + (wiring.estimateRequestOverheadTokens?.(request) ?? wiring.estimateOverheadTokens?.(tools) ?? 0);
}

/** A verified complete server basis retains every non-system occurrence in
 * order, under the same input settings, tools, window and native identity.
 * Replaced system messages are charged in full without subtracting their old
 * server cost. Legacy reports retain the all-message match and local floor.
 * Additions still use the local heuristic, so this is not an exact tokenizer.
 */
export function preparedRequestTokenBasis(request: ProviderRequest, local: number,
  reported: ReportedRequestBasis | undefined, windowId: string | undefined,
  estimatePromptTokens: (messages: ReadonlyArray<ProviderMessage>) => number,
  nativeIdentity?: ProviderNativeRequestIdentity | null,
  estimateTextPromptTokens?: (messages: ReadonlyArray<ProviderMessage>) => number,
  persistableInput?: PersistablePromptInputIdentity): number {
  return evaluatePreparedRequestBudget(request, local, reported, windowId, estimatePromptTokens,
    nativeIdentity, estimateTextPromptTokens, persistableInput).decision.tokens;
}

export type PreparedRequestBudgetEvaluation = {
  readonly decision: PromptBudgetBasisDecision;
  readonly measurement: PromptMeasurement;
  /** Runtime proof only: the full current input, not a measured prefix plus
   * a zero-valued estimate for changed/empty messages. Never journaled. */
  readonly exactInputTokens?: number;
};

/** One immutable prepared view supplies both the admission number and its
 * hash-only observation. No provider/native owner is called in this function. */
export function evaluatePreparedRequestBudget(request: ProviderRequest, local: number,
  reported: ReportedRequestBasis | undefined, windowId: string | undefined,
  estimatePromptTokens: (messages: ReadonlyArray<ProviderMessage>) => number,
  nativeIdentity?: ProviderNativeRequestIdentity | null,
  estimateTextPromptTokens?: (messages: ReadonlyArray<ProviderMessage>) => number,
  persistableInput?: PersistablePromptInputIdentity,
  purpose: "admission" | "automatic" = "admission"): PreparedRequestBudgetEvaluation {
  const current = capturePromptMeasurement(request, nativeIdentity, persistableInput);
  const observed = completeInputObservation(reported?.storedInputBasis?.input ?? reported?.inputTokenObservation);
  const make = (basis: PromptBudgetBasisDecision["basis"], tokens: number, reason: PromptBudgetBasisReason,
    addedTokens?: number, exactInputTokens?: number): PreparedRequestBudgetEvaluation => ({ measurement: current,
    ...(exactInputTokens === undefined ? {} : { exactInputTokens }), decision: {
    basis, tokens, localEstimate: local, reason, requestDigest: associatedRequestDigest(request, current),
    ...(observed === undefined ? {} : { inputTokenObservation: observed, observedInputTokens: observed.tokens }),
    ...(addedTokens === undefined ? {} : { addedTokens }),
  } });
  const fallback = (reason: PromptBudgetBasisReason) => make("local", local, reason);

  if (reported === undefined) return fallback("no_report");

  if (reported.storedInputBasis !== undefined) {
    const restored = evaluateStoredPromptInputBasis(request, current, reported.storedInputBasis,
      estimatePromptTokens, estimateTextPromptTokens,
      purpose === "automatic" ? { currentTokens: local } : undefined);
    return restored.kind === "matched"
      ? make("server_plus_added", restored.tokens, "complete_prompt_preserved", restored.addedTokens)
      : fallback(restored.reason);
  }

  const measurement = reported.measurement;
  if (measurement === undefined) return fallback("measurement_unavailable");

  if (!hasMessageIdentity(measurement)) return fallback("invalid_report");

  if (reported.windowId !== windowId) return fallback("window_changed");

  if (measurement.toolDigest !== current.toolDigest) return fallback("tools_changed");

  if (measurement.model !== undefined && measurement.model !== request.model) return fallback("model_changed");

  if (measurement.settingsDigest !== undefined && measurement.settingsDigest !== current.settingsDigest) return fallback("request_settings_changed");

  const native = nativeIdentity === undefined ? undefined : copyNativeIdentity(nativeIdentity, request.messages.length);
  const previousNative = measurement.nativeIdentity === undefined ? undefined
    : copyNativeIdentity(measurement.nativeIdentity, measurement.messageDigests.length);
  if (native === null || previousNative === null || native !== undefined && estimateTextPromptTokens === undefined) return fallback("native_unverifiable");

  if ((native === undefined) !== (previousNative === undefined)
    || native !== undefined && native.requestDigest !== previousNative?.requestDigest) return fallback("native_changed");

  const calibrated = observed !== undefined && hasInputIdentity(measurement);
  if (!calibrated && (!Number.isFinite(reported.promptTokens) || reported.promptTokens <= 0)) return fallback("invalid_report");

  if (calibrated && native !== undefined && previousNative !== undefined
    && !nativeSystemsPreserved(request, measurement, native, previousNative)) return fallback("native_changed");

  let added = calibrated ? calibratedAdditions(request, current, measurement, native, previousNative)
    : legacyAdditions(current, measurement, native, previousNative);
  if (added === undefined) return fallback("history_changed");

  // The text estimator cannot price a new image. Keep the old all-message
  // matching and local floor instead of treating its encoded bytes as tokens.
  const unpricedMedia = calibrated && added.some(index => hasMedia(request.messages[index]!));
  if (unpricedMedia) {
    added = legacyAdditions(current, measurement, native, previousNative);
    if (added === undefined || !Number.isFinite(reported.promptTokens) || reported.promptTokens <= 0) return fallback("unpriced_media");
  }

  const messages = added.map(index => request.messages[index]!);
  const addedNativeTokens = added.reduce((sum, index) => sum + (native?.messageOverheadTokens[index] ?? 0), 0);
  const addedTokens = messages.length === 0 ? 0 : native === undefined ? estimatePromptTokens(messages)
    : estimateTextPromptTokens!(messages) + addedNativeTokens;

  const identicalInput = calibrated && !unpricedMedia && measurement.messageDigests.length === current.messageDigests.length
    && measurement.messageDigests.every((digest, index) => digest === current.messageDigests[index])
    && (native === undefined || native.messageFieldDigests.every((digest, index) => digest === previousNative?.messageFieldDigests[index]));

  // Admission keeps its conservative full replacement charge. Automatic
  // maintenance can re-estimate the current system text instead: charging
  // the whole new host packet on top of a count that already included the old
  // packet repeatedly invents pressure. Keep the observed floor and every new
  // non-system/native addition; this estimate never proves a hard overflow.
  if (purpose === "automatic" && calibrated && !unpricedMedia
    && added.some(index => request.messages[index]!.role === "system") && removedMeasuredSystem(current, measurement)) {
    const nonSystem = added.filter(index => request.messages[index]!.role !== "system");
    const messages = nonSystem.map(index => request.messages[index]!);
    const extra = native === undefined ? estimatePromptTokens(messages)
      : estimateTextPromptTokens!(messages) + nonSystem.reduce((sum, index) => sum + native.messageOverheadTokens[index]!, 0);
    return make("server_plus_added", Math.max(local, observed.tokens + extra), "complete_prompt_preserved", extra);
  }

  return calibrated && !unpricedMedia ? make("server_plus_added", observed.tokens + addedTokens, "complete_prompt_preserved", addedTokens,
    identicalInput ? observed.tokens : undefined)
    : make("legacy_max", Math.max(local, reported.promptTokens + addedTokens), unpricedMedia ? "unpriced_media" : "legacy_or_unknown_source", addedTokens);
}

function removedMeasuredSystem(current: PromptMeasurement, previous: PromptMeasurement): boolean {
  const remaining = current.messageDigests.filter((_digest, index) => current.messageRoles?.[index] === "system");
  for (const [index, role] of previous.messageRoles!.entries()) {
    if (role !== "system") continue;
    const match = remaining.indexOf(previous.messageDigests[index]!);
    if (match < 0) return true;
    remaining.splice(match, 1);
  }
  return false;
}

/** Output reservation/clamping changes association, never input calibration.
 * A final view may update this pure digest without measuring native state again. */
export function associatePromptBudgetDecision(decision: PromptBudgetBasisDecision, request: ProviderRequest,
  measurement: PromptMeasurement): PromptBudgetBasisDecision {
  return { ...decision, requestDigest: associatedRequestDigest(request, measurement) };
}

function completeInputObservation(value: CompleteInputTokenObservation | undefined): CompleteInputTokenObservation | undefined {
  return value !== undefined && value !== null && value.kind === "complete_prompt" && value.source === "provider_complete_input"
    && Number.isSafeInteger(value.tokens) && value.tokens >= 0
    ? { kind: "complete_prompt", source: "provider_complete_input", tokens: value.tokens } : undefined;
}

function hasInputIdentity(value: PromptMeasurement): boolean {
  return typeof value.model === "string" && typeof value.settingsDigest === "string" && /^[a-f0-9]{64}$/.test(value.settingsDigest)
    && Array.isArray(value.messageRoles) && value.messageRoles.length === value.messageDigests.length
    && Array.from(value.messageRoles).every(role => role === "system" || role === "user" || role === "assistant" || role === "tool");
}

function hasMessageIdentity(value: PromptMeasurement): boolean {
  return typeof value === "object" && value !== null && typeof value.toolDigest === "string" && /^[a-f0-9]{64}$/.test(value.toolDigest)
    && Array.isArray(value.messageDigests)
    && Array.from(value.messageDigests).every(digest => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest));
}

function hasMedia(message: ProviderMessage): boolean {
  return (message.attachments?.length ?? 0) > 0 || (message.imageReferences?.length ?? 0) > 0;
}

function sameMeasuredMessage(index: number, oldIndex: number, current: PromptMeasurement, previous: PromptMeasurement,
  native: ProviderNativeRequestIdentity | undefined, oldNative: ProviderNativeRequestIdentity | undefined): boolean {
  return current.messageDigests[index] === previous.messageDigests[oldIndex]
    && (native === undefined || native.messageFieldDigests[index] === oldNative?.messageFieldDigests[oldIndex]);
}

function legacyAdditions(current: PromptMeasurement, previous: PromptMeasurement,
  native: ProviderNativeRequestIdentity | undefined, oldNative: ProviderNativeRequestIdentity | undefined): number[] | undefined {
  let matched = 0;
  const added: number[] = [];

  for (let index = 0; index < current.messageDigests.length; index++) {
    if (matched < previous.messageDigests.length && sameMeasuredMessage(index, matched, current, previous, native, oldNative)) matched++;
    else added.push(index);
  }

  return matched === previous.messageDigests.length ? added : undefined;
}

function calibratedAdditions(request: ProviderRequest, current: PromptMeasurement, previous: PromptMeasurement,
  native: ProviderNativeRequestIdentity | undefined, oldNative: ProviderNativeRequestIdentity | undefined): number[] | undefined {
  const oldSystems: number[] = [], oldHistory: number[] = [];

  for (const [index, role] of previous.messageRoles!.entries()) (role === "system" ? oldSystems : oldHistory).push(index);

  let history = 0, system = 0;
  const added: number[] = [];

  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      const matching = oldSystems.findIndex((oldIndex, cursor) => cursor >= system
        && sameMeasuredMessage(index, oldIndex, current, previous, native, oldNative));
      if (matching >= 0) system = matching + 1;
      else added.push(index);
    } else if (history < oldHistory.length && sameMeasuredMessage(index, oldHistory[history]!, current, previous, native, oldNative)) history++;
    else added.push(index);
  }

  return history === oldHistory.length ? added : undefined;
}

/** Preserve native system occurrence identity independently of allowed text
 * replacement. If a removed native-bearing slot cannot be matched, fall back. */
function nativeSystemsPreserved(request: ProviderRequest, previous: PromptMeasurement,
  native: ProviderNativeRequestIdentity, oldNative: ProviderNativeRequestIdentity): boolean {
  const old = previous.messageRoles!.flatMap((role, index) => role === "system" ? [oldNative.messageFieldDigests[index]] : []);
  let matched = 0;
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system" && native.messageFieldDigests[index] === old[matched]) matched++;
  }
  return matched === old.length;
}

function inputSettingsDigest(request: ProviderRequest): string {
  const excluded = new Set(["attemptId", "observeReturn", "model", "messages", "tools", "maxOutputTokens", "systemPrompt", "systemPromptAppend"]);
  return digestOf(Object.fromEntries(Object.entries(request).filter(([key]) => !excluded.has(key))));
}

function associatedRequestDigest(request: ProviderRequest, measurement: PromptMeasurement): string {
  return digestOf([request.model, measurement.settingsDigest, measurement.toolDigest, measurement.messageDigests,
    measurement.nativeIdentity ?? null, request.maxOutputTokens ?? null,
    ...(measurement.persistableInput === undefined ? [] : [measurement.persistableInput])]);
}

/**
 * A server measurement describes one immutable request prefix. Reinserted
 * exchanges and transient instructions can change that prefix without
 * changing a window id. Only an unchanged prefix can reuse its measured size;
 * subtracting an estimated saving from a server number would invent accuracy.
 */
export function requestTokenBasis(input: CompactionInput): number {
  const wiring = input.wiring;
  if (wiring === undefined) return 0;

  const messages = currentPromptMessages(input);
  const local = estimateCurrentView(input, messages);
  const reported = input.reported;
  const measurement = reported?.measurement;
  if (reported === undefined || reported.promptTokens <= 0 || measurement === undefined || measurement.nativeIdentity !== undefined
    || reported.windowId !== input.ledger.window?.windowId
    || measurement.toolDigest !== digestOf(input.tools === undefined ? [] : toolSpecs(input.tools))
    || !hasMeasuredPrefix(messages, measurement)) return local;

  const additions = messages.slice(measurement.messageDigests.length);
  const added = wiring.estimatePromptTokens(additions);
  const observed = completeInputObservation(reported.inputTokenObservation);

  // The unchanged measured prefix already includes its text and tool table.
  // A byte upper bound is not a second floor on a complete provider count;
  // using it here would re-trigger the gap immediately after fit accepted the
  // calibrated request. Legacy/unknown usage keeps its conservative contract.
  return observed !== undefined && hasInputIdentity(measurement) && !additions.some(hasMedia)
    ? observed.tokens + added : Math.max(local, reported.promptTokens + added);
}

/** The exact current projection, including decorations and provider-owned overhead. */
export function localViewBasis(input: CompactionInput): number {
  return input.wiring === undefined ? 0 : estimateCurrentView(input, currentPromptMessages(input));
}

export function currentPromptMessages(input: CompactionInput): ReadonlyArray<ProviderMessage> {
  return requestMessages(promptViewMessages(input), input.seedMessages.length, {
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.systemPromptAppend === undefined ? {} : { systemPromptAppend: input.systemPromptAppend }),
  });
}

function estimateCurrentView(input: CompactionInput, messages: ReadonlyArray<ProviderMessage>): number {
  const wiring = input.wiring;
  if (wiring === undefined) return 0;
  const overhead = input.tools === undefined ? 0 : wiring.estimateOverheadTokens?.(input.tools) ?? 0;
  return wiring.estimatePromptTokens(messages) + overhead;
}

function hasMeasuredPrefix(messages: ReadonlyArray<ProviderMessage>, measurement: PromptMeasurement): boolean {
  return messages.length >= measurement.messageDigests.length
    && measurement.messageDigests.every((digest, index) => digestOf(messages[index]) === digest);
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
