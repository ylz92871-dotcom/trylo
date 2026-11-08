import { scrubDisclosure } from "../../compaction/disclosure.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { SkillTaskExtractionInput } from "./task-contract.js";

export type SkillTaskRecord = {
  readonly material: string;
  readonly inputDigest: string;
  readonly toolSequences: readonly number[];
  readonly hadFailureRecovery: boolean;
  readonly checkSources: readonly { readonly label: string; readonly eventId: string }[];
};

/** Transient model input only. No hidden reasoning, system prompts or file bodies are projected. */
export function skillTaskRecord(input: SkillTaskExtractionInput): { readonly ok: true; readonly record: SkillTaskRecord }
  | { readonly ok: false; readonly reason: string } {
  const qualification = input.qualification;
  if (qualification === undefined) return { ok: false, reason: "task_has_no_qualified_outcome" };

  const boundary = input.fromSequence ?? [...input.transcript].reverse().find(item => item.kind === "user" && item.text === input.taskText)?.sequence;
  if (boundary === undefined) return { ok: false, reason: "task_transcript_boundary_missing" };

  const current = input.transcript.filter(item => item.sequence >= boundary);
  const calls = current.filter(item => item.kind === "tool_call");
  if (calls.length < 2) return { ok: false, reason: "task_needs_reusable_execution_steps" };

  if (calls.length > 128) return { ok: false, reason: "task_trace_exceeds_capacity" };

  const seen = new Set<string>();
  const tools: { sequence: number; name: string; arguments: Readonly<Record<string, string>>;
    result: { sequence: number; outcome: string; truncated: boolean; output: string; outputShortened: boolean } }[] = [];

  for (const call of calls) {
    if (seen.has(call.toolCallId)) return { ok: false, reason: "task_tool_identity_ambiguous" };

    seen.add(call.toolCallId);
    const matches = current.filter(item => item.kind === "tool_result" && item.toolCallId === call.toolCallId && item.sequence > call.sequence);
    const result = matches[0];
    if (matches.length !== 1 || result?.kind !== "tool_result") return { ok: false, reason: "task_tool_result_unbound" };

    tools.push({ sequence: call.sequence, name: call.name, arguments: safeArguments(call.arguments),
      result: { sequence: result.sequence, outcome: result.outcome, truncated: result.truncated,
        output: scrubDisclosure(result.output).slice(0, 4096), outputShortened: result.output.length > 4096 } });
  }

  const checkSources = qualification.kind === "external_check" ? qualification.checks
    : qualification.kind === "execution_failure" ? [{ label: qualification.failureMode, eventId: qualification.ref }] : [];
  if (checkSources.length === 0 || checkSources.some(item => !item.label.trim() || !item.eventId.trim())) return { ok: false, reason: "task_check_reference_missing" };

  if (qualification.kind === "external_check" && checkSources.some(check => !input.events.some(event =>
    event.eventId === check.eventId && (event.kind === "check_result" || event.kind === "tool_result")
    && (event.sessionId === undefined || event.sessionId === input.sessionId) && (event.turnId === undefined || event.turnId === input.turnId)))) {
    return { ok: false, reason: "task_check_reference_unbound" };
  }

  const prior = input.priorEpisodes ?? [];
  const examples = prior.slice(-16).map(episode => ({ taskFamily: episode.taskFamily, outcome: episode.outcome,
    steps: episode.steps.map(scrubDisclosure), checks: episode.checks.map(scrubDisclosure),
    ...(episode.failureMode === undefined ? {} : { failureMode: scrubDisclosure(episode.failureMode) }) }));
  const payload = { task: scrubDisclosure(input.taskText), tools, trustedOutcome: qualification.outcome,
    checks: checkSources.map(check => ({ ...check, label: scrubDisclosure(check.label) })),
    existingFamilies: input.priorFamilies ?? [],
    runtimeFacts: input.facts ?? {},
    ...(input.expectedFamily === undefined ? {} : { expectedFamily: input.expectedFamily }),
    comparablePriorExamples: examples, priorExamplesShortened: prior.length > examples.length,
    ...(qualification.kind === "execution_failure" ? { failure: scrubDisclosure(qualification.failureMode) } : {}) };
  const material = canonicalJson(payload);

  return { ok: true, record: { material, inputDigest: contentHashOf(payload), toolSequences: calls.map(item => item.sequence), checkSources,
    hadFailureRecovery: tools.some((tool, index) => tool.result.outcome === "failed" && tools.slice(index + 1).some(later => later.result.outcome === "succeeded")) } };
}

function safeArguments(input: JsonObject): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const key of ["path", "filePath", "file_path", "command", "cmd", "pattern", "query", "skill", "args"]) {
    const value = input[key];
    if (typeof value === "string") fields[key] = scrubDisclosure(value).slice(0, 4096);
  }
  return fields;
}
