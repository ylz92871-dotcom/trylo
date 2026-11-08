import { contentHashOf } from "../../../../control/hash.js";
import type { CandidateExecutor, CandidateExecution } from "../domain/evolution/execution.js";
import type { ToolEvolutionCandidate } from "../domain/evolution/contracts.js";
import { TOOL_EVOLUTION_MAX_SAMPLE_BYTES } from "../domain/evolution/contracts.js";
import { isJsonValue, jsonBytes, keysAre } from "../domain/evolution/parse.js";
import { candidateToolName, type ToolUseRecord } from "../domain/evolution/use.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../../../ports/tools.js";
import { sanitizeToolDescription } from "../../../../../tooling/catalog/description-guard.js";
import type { ToolRuntimeDescriptor } from "../../../../../tooling/contract/descriptor.js";
import type { PipelineFailure } from "./pipeline-assets.js";
import { recordFrozenToolUse } from "./use-recording.js";

export type FrozenUseOptions = {
  readonly boardRoot: string; readonly versionId: string; readonly sessionId: string; readonly workspaceId: string;
  readonly executor: CandidateExecutor; readonly now: () => number; readonly newId: () => string; readonly warn: (message: string) => void;
  readonly taskSituation?: string;
};

export type FrozenUseSelection = { readonly ok: true; readonly candidate: ToolRuntimeDescriptor | ToolEvolutionCandidate; readonly scope: string;
  readonly contentHash: string; readonly nameDigest: string; readonly label: string; readonly usageGuidance?: readonly string[];
  readonly usageLessonBindings?: readonly { readonly decisionVersionId: string; readonly text: string }[] };

export type FrozenUseRead = () => Promise<FrozenUseSelection | PipelineFailure>;

export type FrozenUseMount = { readonly tools: ToolPort; readonly binding: ToolBinding; readonly source: string; close(): Promise<void> };

/** One call/record/cleanup implementation for lab trials and approved packages; readers own their distinct admission policy. */
export function openFrozenToolUse(options: FrozenUseOptions, selected: FrozenUseSelection, read: FrozenUseRead,
  execute: (input: Parameters<CandidateExecutor["execute"]>[1], signal: AbortSignal) => Promise<CandidateExecution> = (input, signal) =>
    "source" in selected.candidate ? options.executor.execute(selected.candidate, input, signal) : Promise.resolve({ kind: "unavailable", detail: "no executor for this package profile" })) {
  const candidate = selected.candidate;
  const guidance = (selected.usageGuidance ?? []).filter(text => {
    const guarded = sanitizeToolDescription(text);
    if (!guarded.ok) options.warn("tool_feedback_guidance_refused: unsafe advisory text omitted");
    return guarded.ok;
  });
  // A later correction gets a bounded visible slot; otherwise long static mastery can hide every update.
  const description = sanitizeToolDescription([...guidance.map(text => text.slice(0, 384)).slice(-2), candidate.description,
    ...candidate.mastery.whenToUse, ...candidate.mastery.preconditions, ...candidate.mastery.pitfalls].join("\n"));
  if (!description.ok) return { ok: false as const, code: description.code, message: "candidate description was refused" };

  const usageLessonRefs = [...new Set((selected.usageLessonBindings ?? []).flatMap(row => {
    const guarded = sanitizeToolDescription(row.text);
    return guidance.includes(row.text) && guarded.ok && description.text.includes(guarded.text) ? [row.decisionVersionId] : [];
  }))].slice(0, 2);
  const binding: ToolBinding = { name: candidateToolName(candidate.identity, selected.nameDigest), versionId: options.versionId,
    description: `${selected.label} ${options.versionId}. Quality on this task is unverified.\n${description.text}`,
    parameters: { type: "object", properties: { input: candidate.inputSchema }, required: ["input"], additionalProperties: false },
    sideEffect: "external", needsApproval: true, parallelSafe: false, timeoutMs: 120_000,
    outputLimits: { maxBytes: 65_536, maxLines: 2000 } };
  const calls = new Map<string, { readonly inputHash: string; readonly promise: Promise<ToolOutcome> }>();
  const active = new Map<string, AbortController>();
  const reading = new Set<{ readonly toolCallId: string; readonly controller: AbortController }>();
  let closed = false;
  const invoke = async (call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> => {
    if (closed || signal.aborted) return { outcome: "cancelled" };

    if (call.name !== binding.name) return error("unknown_tool", "candidate was not mounted under this name");

    if (!isJsonValue(call.arguments) || !keysAre(call.arguments, ["input"]) || !isJsonValue(call.arguments.input)
      || jsonBytes(call.arguments.input) > TOOL_EVOLUTION_MAX_SAMPLE_BYTES) return error("invalid_arguments", "expected one bounded JSON input field");

    // Authority reads are asynchronous too. Register before awaiting them so a
    // call-ID cancellation cannot disappear before the executor owns the call.
    const pendingRead = { toolCallId: call.toolCallId, controller: new AbortController() };
    reading.add(pendingRead);
    let current: Awaited<ReturnType<typeof safeRead>>;

    try { current = await safeRead(read); }
    finally { reading.delete(pendingRead); }

    if (closed || signal.aborted || pendingRead.controller.signal.aborted) return { outcome: "cancelled" };

    if (!current.ok) return error(current.code, current.message);

    if (current.contentHash !== selected.contentHash || current.scope !== selected.scope || current.nameDigest !== selected.nameDigest) return error("tool_version_changed", "mounted version is no longer the selected immutable asset");

    if (closed || signal.aborted) return { outcome: "cancelled" };

    const input = structuredClone(call.arguments.input), inputHash = contentHashOf(input);
    const prior = calls.get(call.toolCallId);
    if (prior !== undefined) return prior.inputHash === inputHash ? prior.promise : error("tool_use_conflict", "tool call ID already binds another input");

    if (calls.size >= 128) return error("tool_use_capacity", "per-run candidate call limit reached");

    const controller = new AbortController();
    active.set(call.toolCallId, controller);
    const promise = Promise.resolve().then(async () => {
      const combined = AbortSignal.any([signal, controller.signal]);
      let execution: CandidateExecution;

      if (closed || combined.aborted) return { outcome: "cancelled" as const };

      try { execution = await execute(input, combined); }
      catch { execution = { kind: "unavailable", detail: "execution adapter failed" }; }

      const record: ToolUseRecord = { schemaVersion: 1, useId: options.newId(), versionId: options.versionId, scope: selected.scope,
        sessionId: options.sessionId, workspaceId: options.workspaceId, toolCallId: call.toolCallId, inputHash, contentHash: selected.contentHash,
        execution: execution.kind === "value" ? "returned" : execution.kind,
        ...(execution.kind === "value" ? { outputHash: contentHashOf(execution.value) } : {}), quality: "unverified", occurredAt: new Date(options.now()).toISOString(),
        ...(usageLessonRefs.length === 0 ? {} : { usageLessonRefs }) };
      const saved = await recordFrozenToolUse(options, record, combined);
      if (!saved.ok) options.warn(`tool_use_not_recorded:${saved.reason}:${record.useId}`);

      return toolOutcome(execution, options.versionId, saved.ok);
    }).finally(() => { active.delete(call.toolCallId); });

    calls.set(call.toolCallId, { inputHash, promise });
    return promise;
  };
  const mount: FrozenUseMount = { binding, source: "source" in candidate ? candidate.source : `managed-package:${options.versionId}`,
    tools: { snapshot: () => closed ? [] : [structuredClone(binding)], execute: invoke, cancel: async id => {
      for (const pending of reading) if (pending.toolCallId === id) pending.controller.abort();
      active.get(id)?.abort();
    } },
    close: async () => { closed = true;
    for (const pending of reading) pending.controller.abort();
      for (const controller of active.values()) controller.abort();
    await Promise.allSettled([...calls.values()].map(item => item.promise)); } };

  return { ok: true as const, mount };
}

async function safeRead(read: FrozenUseRead) {
  try { return await read(); }
  catch { return { ok: false as const, code: "tool_asset_unavailable", message: "immutable tool authority could not be read" }; }
}

function toolOutcome(execution: CandidateExecution, versionId: string, recorded: boolean): ToolOutcome {
  if (execution.kind === "cancelled") return { outcome: "cancelled" };
  if (execution.kind === "value") return { outcome: "result", value: { result: execution.value, candidateVersionId: versionId,
    quality: "unverified", useRecording: recorded ? "recorded" : "unavailable" }, output: JSON.stringify(execution.value), truncated: false };
  if (execution.kind === "tool_error") return error("candidate_tool_error", execution.message ?? `candidate reported interface error: ${execution.code}`);
  if (execution.kind === "unavailable") return error("candidate_execution_unavailable", execution.detail);
  return error(execution.kind === "timeout" ? "candidate_timeout" : "candidate_protocol_error", execution.detail);
}

function error(code: string, message: string): ToolOutcome { return { outcome: "error", code, message }; }
