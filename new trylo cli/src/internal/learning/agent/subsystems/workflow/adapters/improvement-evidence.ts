import type { SessionRecord } from "../../../../../ports/session.js";
import { isTranscriptItem } from "../../../../../protocol/transcript.js";
import { redactJsonValue } from "../../../../../protocol/redact.js";
import { redactText } from "../../../../../credentials/redact.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { WorkflowImprovementEvidenceSnapshot, WorkflowImprovementReceipt } from "../runtime/improvement-contracts.js";
import type { WorkflowImprovementEvidence } from "../improvement/contracts.js";
import { record, workflowFailure } from "../domain/trace-parse.js";
import { workflowCheckStatus } from "../runtime/check-receipt.js";
import { isCentralLearningSourceContext } from "../../../../control/source-context.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isContentValueCredentialSafe } from "../../../../../integration/learning-content/content-confidentiality-leaf.js";
import { parseEnvelope } from "../../../../../protocol/validate.js";
import { createPublicToolResultReader, PublicToolResultError } from "../../../../../protocol/public-tool-result.js";

function publicText(value: string, secrets: readonly string[], max = 1200): string {
  const redacted = redactJsonValue(redactText(value, secrets));
  return typeof redacted === "string" ? redacted.slice(0, max) : "[redacted]";
}

/** Failures often end with the useful cause, while long commands occupy the prefix.
 * Redact the complete text before selecting excerpts so cuts cannot split a secret. */
function resultExcerpt(value: string, secrets: readonly string[]): string {
  const redacted = publicText(value, secrets, value.length);
  if (redacted.length <= 600) return redacted;
  return `${redacted.slice(0, 200)}\n[... ${redacted.length - 600} redacted characters omitted ...]\n${redacted.slice(-400)}`;
}

/** Only public scalar diagnostics survive; result bodies, paths and arbitrary fields do not. */
function resultDiagnostics(payload: JsonObject): string {
  const diagnostics: Record<string, number | boolean> = {};

  if (typeof payload.truncated === "boolean") diagnostics.outputTruncated = payload.truncated;

  if (record(payload.value)) for (const key of ["exitCode", "totalMatches", "totalLines", "startLine", "endLine", "nextOffset",
    "truncated", "truncatedLines", "truncatedBytes", "timedOut", "aborted"]) {
    const value = payload.value[key];
    if (typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value)) diagnostics[key] = value;
  }

  return Object.keys(diagnostics).length === 0 ? "" : `; diagnostics=${JSON.stringify(diagnostics)}`;
}

/** Recursive rejection prevents a model from putting a credential into a Board report. */
export function workflowImprovementPublicData(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === "string") return publicText(value, secrets, value.length) === value;
  if (Array.isArray(value)) return value.every(item => workflowImprovementPublicData(item, secrets));
  if (record(value)) return Object.entries(value).every(([key, item]) => workflowImprovementPublicData(key, secrets) && workflowImprovementPublicData(item, secrets));
  return value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}

/** Only host-built research inputs use this boundary. Canonical source frames
 * contain workspace identity paths; model reports keep the stricter public-data
 * policy above. The original frame, hash and credential checks remain intact. */
export function workflowImprovementContextPublicData(value: unknown, secrets: readonly string[]): boolean {
  if (!record(value)) return false;

  const { centralContent, ...business } = value;

  if (!workflowImprovementPublicData(business, secrets)) return false;

  if (centralContent === undefined) return true;

  return isCentralLearningSourceContext(centralContent)
    && ["content-issue-context:", "central-runtime-context:"].some(prefix => centralContent.ref === prefix + contentHashOf(centralContent.text))
    && isContentValueCredentialSafe(centralContent, secrets);
}

/** Bounded public facts, paired from the canonical journal; hidden reasoning is never read. */
export function projectWorkflowImprovementEvidence(records: readonly SessionRecord[], sessionId: string, secrets: readonly string[] = []) {
  // Pair the original public stream before bounding the exposed evidence.
  // Private deltas must not evict a real call or split a lossless result.
  const scoped = records.filter(item => item.sessionId === sessionId);
  const turnId = [...scoped].reverse().find(item => item.turnId !== undefined)?.turnId;
  if (turnId === undefined) return workflowFailure("workflow_no_turn", "No committed turn can supply learning evidence");

  const executionId = `${sessionId}/${turnId}`;
  const proposals = new Map<string, { readonly name: string; readonly arguments: JsonObject }>();
  const calls = new Map<string, { readonly name: string; readonly arguments: JsonObject;
    readonly toolCallId: string; readonly executionId: string }>();
  const evidence: WorkflowImprovementEvidence[] = [], receipts: WorkflowImprovementReceipt[] = [];
  const publicResults = createPublicToolResultReader();

  for (const item of scoped) {
    if (item.type === "transcript_item" && isTranscriptItem(item.payload)) {
      if (item.turnId === undefined) continue;
      if (item.payload.kind === "user") evidence.push({ ref: `session:${sessionId}/turn:${item.turnId ?? turnId}/input:${item.sequence}`,
        kind: "user_input", executionId: `${sessionId}/${item.turnId ?? turnId}`, summary: publicText(item.payload.text, secrets) });
      if (item.payload.kind === "tool_call") proposals.set(`${item.turnId}:${item.payload.toolCallId}`, { name: item.payload.name, arguments: item.payload.arguments });
      continue;
    }

    if (item.type !== "envelope" || !record(item.payload.envelope)) continue;

    const original = item.payload.envelope;
    if (original.producerId !== "loop" || original.sessionId !== sessionId || typeof original.turnId !== "string"
      || item.turnId !== original.turnId) continue;

    const parsed = parseEnvelope(original);
    if (!parsed.ok) return workflowFailure("workflow_evidence_frame_invalid", `Original public source frame rejected: ${parsed.code}`);

    let resolved;

    try { resolved = publicResults.push(parsed.envelope); }
    catch (error) {
      if (!(error instanceof PublicToolResultError)) throw error;
      return workflowFailure("workflow_evidence_frame_invalid", `Original public result rejected: ${error.code}`);
    }

    if (resolved.kind === "part") continue;

    const envelope = resolved.value, payload = envelope.payload;
    if (typeof payload.toolCallId !== "string") continue;

    const callKey = `${envelope.turnId}:${payload.toolCallId}`;

    if (envelope.kind === "tool_use") {
      calls.delete(callKey);
      const original = proposals.get(callKey), args = record(payload.arguments) ? payload.arguments as JsonObject
        : original !== undefined && original.name === payload.name ? original.arguments : undefined;

      proposals.delete(callKey);

      if (typeof payload.name === "string" && args !== undefined) calls.set(callKey, { name: payload.name, arguments: args,
        toolCallId: payload.toolCallId, executionId: `${sessionId}/${envelope.turnId}` });

      continue;
    }

    if (envelope.kind !== "tool_result") continue;

    const call = calls.get(callKey);

    calls.delete(callKey);
    proposals.delete(callKey);

    if (call === undefined) continue;

    if (call.name === "workflow_learning") {
      const result = record(payload.value) && record(payload.value.result) ? payload.value.result : undefined;
      if (call.arguments.operation === "context" && payload.status === "succeeded" && result?.status === "not_applicable") {
        const report = record(call.arguments.report) ? call.arguments.report : {};
        const task = record(report.task) ? report.task : {};

        // An actual refusal can motivate research. It is not a post-use
        // business receipt, adopted exposure, quality verdict or benefit.
        evidence.push({ ref: `session:${sessionId}/turn:${envelope.turnId}/tool:${payload.toolCallId}`,
          executionId: call.executionId, kind: "tool_success",
          summary: publicText(`workflow_learning context; native status=not_applicable; requestedBoundary=${JSON.stringify(report.boundary ?? null)}; requestedConditions=${JSON.stringify(task.conditions ?? {})}; learning availability observation only: no workflow use or business-quality assessment.`, secrets, 2048) });
      }

      continue;
    }

    const outcome = payload.status === "succeeded" || payload.status === "failed" || payload.status === "cancelled" ? payload.status : "unknown";
    const ref = `session:${sessionId}/turn:${item.turnId ?? turnId}/tool:${payload.toolCallId}`;
    const detail = call.arguments.command ?? call.arguments.path ?? call.arguments.pattern ?? call.arguments.query;
    const exitCode = record(payload.value) ? payload.value.exitCode : undefined;
    const checkStatus = call.name === "run_shell" && (outcome === "succeeded" || outcome === "failed")
      && typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? workflowCheckStatus(payload as JsonObject) : undefined;

    receipts.push({ ref, sequence: item.sequence, executionId: `${sessionId}/${item.turnId ?? turnId}`, toolCallId: payload.toolCallId,
      tool: call.name, outcome, ...(checkStatus === undefined ? {} : { checkStatus }) });
    const command = typeof detail === "string" ? publicText(detail, secrets, 320) : "";
    const commandBound = typeof detail === "string" && detail.length > 320 ? " [command abbreviated]" : "";
    const message = typeof payload.message === "string" ? `; message=${resultExcerpt(payload.message, secrets)}` : "";
    const code = typeof payload.code === "string" ? `; code=${publicText(payload.code, secrets, 100)}` : "";
    const resultSummary = typeof payload.output === "string" ? `; resultExcerpt=${resultExcerpt(payload.output, secrets)}` : "";

    evidence.push({ ref, executionId: `${sessionId}/${item.turnId ?? turnId}`,
      kind: checkStatus === "failed" || outcome === "failed" ? "tool_failure"
        : checkStatus === "passed" || outcome === "succeeded" ? "tool_success" : "context",
      summary: publicText(`${call.name} ${command}${commandBound}; callOutcome=${outcome}; checkStatus=${checkStatus ?? "unknown"}${resultDiagnostics(payload as JsonObject)}${code}${message}${resultSummary}`, secrets, 2048) });
  }

  publicResults.close();
  // Preserve the latest input together with recent receipts rather than letting noisy tools evict intent.
  const user = evidence.filter(item => item.kind === "user_input").slice(-3);
  const tools = evidence.filter(item => item.kind !== "user_input").slice(-24);
  const selected = [...user, ...tools], selectedRefs = new Set(selected.map(item => item.ref));
  const pendingHooks: NonNullable<WorkflowImprovementEvidenceSnapshot["pendingHooks"]>[number][] = [];

  for (const call of calls.values()) {
    const operation = call.arguments.operation;
    if (call.name !== "workflow_learning" || operation !== "context" && operation !== "opportunity" && operation !== "feedback") continue;
    const report = call.arguments.report;
    pendingHooks.push({ toolCallId: call.toolCallId, executionId: call.executionId, operation,
      ...(record(report) && typeof report.useId === "string" ? { useId: report.useId } : {}) });
  }

  const value: WorkflowImprovementEvidenceSnapshot = { executionId, watermark: scoped.at(-1)?.sequence ?? 0,
    evidence: selected, receipts: receipts.filter(item => selectedRefs.has(item.ref)), pendingHooks };

  return { ok: true as const, value };
}
