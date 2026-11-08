import type { ToolBinding, ToolPort } from "../../../../../ports/tools.js";
import type { JsonObject, JsonValue } from "../../../../../protocol/envelope.js";
import type { createPersonalAgentCollaboration, PersonalAgentDecision } from "../personal-agent/service.js";
import { isPersonalAgentInspectionReference } from "../personal-agent/service.js";
import { COORDINATION_DECISION_LIMITS, isCoordinationAction, isCoordinationDecisionReason, isCoordinationDecisionSourceRefs } from "../control/index.js";
import { collaborationTimingFor } from "../control/timing.js";
import { EXPERIENCE_FEEDBACK_INPUT_SCHEMA, experienceFeedbackInputIssues, EXPERIENCE_FEEDBACK_LIMITS } from "../experience/index.js";

const TOOL_TEXT_MAX_CHARS = 2000;
const REPORT_SOURCE_LIMIT = 32; // Original LearningIssueReport evidenceRefs capacity.

export { PERSONAL_AGENT_COLLABORATION_INSTRUCTION } from "./personal-agent-instructions.js";

export function createPersonalAgentTools(options: {
  readonly service: ReturnType<typeof createPersonalAgentCollaboration>; readonly scope: string; readonly turnId: string;
  readonly taskId?: string; readonly teamRunId?: string;
  /** Exact original session/turn coordinate supplied by the host, not inferred from taskId. */
  readonly sourceAddress?: string;
  readonly learningToolTimeoutMs?: number;
  readonly capability: (dependencyId: string, signal: AbortSignal) => Promise<unknown>;
  readonly library: (owner: "tool" | "expert", command: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly feedback: (input: unknown) => Promise<unknown>;
}): ToolPort {
  const bindings: ToolBinding[] = [
    binding("collaboration_inspect", "Read current collaboration issues, resources, dependencies and pending actual uses. Select issueId for a focused view; page follow-up with nextAfterReceiptId.", {
      issueId: { type: "string", minLength: 1, maxLength: 512 },
      followUpAfterReceiptId: { type: "string", minLength: 1, maxLength: EXPERIENCE_FEEDBACK_LIMITS.referenceMaxChars } }),
    binding("collaboration_report", "Report or merge a concrete collaboration issue; keep facts and cause guesses separate", {
      problemKey: { type: "string" }, facts: { type: "array", items: { type: "string" } },
      hypotheses: { type: "array", items: { type: "string" } }, evidenceRefs: reportSourceSchema(options.sourceAddress),
      issueId: { type: "string" }, expectedRevision: { type: "integer" } }, ["problemKey", "facts", "evidenceRefs"]),
    binding("collaboration_decide", `PA resolves, handles ordinary scheduling, or focuses an inspected issue. reason: 1-${COORDINATION_DECISION_LIMITS.reasonMaxChars} characters; sourceRefs: 0-${COORDINATION_DECISION_LIMITS.maxSourceRefs} unique refs, 1-${COORDINATION_DECISION_LIMITS.sourceRefMaxChars} characters each. No extra quota.`, {
      inspectionId: { type: "string", minLength: 1, maxLength: TOOL_TEXT_MAX_CHARS },
      issueId: { type: "string", minLength: 1, maxLength: COORDINATION_DECISION_LIMITS.issueIdMaxChars },
      expectedRevision: { type: "integer", minimum: 1, maximum: COORDINATION_DECISION_LIMITS.maxRevision },
      decision: { enum: ["resolved", "ordinary_execution", "focused_learning"] },
      reason: { type: "string", minLength: 1, maxLength: COORDINATION_DECISION_LIMITS.reasonMaxChars, description: "Brief decision rationale; do not paste a long analysis. Whitespace-only text is invalid." },
      sourceRefs: { type: "array", minItems: 0, maxItems: COORDINATION_DECISION_LIMITS.maxSourceRefs, uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: COORDINATION_DECISION_LIMITS.sourceRefMaxChars }, description: "Actual evidence references, unique; use [] when none are known. Whitespace-only references are invalid." } },
    ["inspectionId", "issueId", "expectedRevision", "decision", "reason", "sourceRefs"]),
    binding("collaboration_capability", "PA requests user consent for one centrally linked capability need, or observes its latest library result", {
      dependencyId: { type: "string" } }, ["dependencyId"]),
    binding("collaboration_resume", "Request follow-up after meaningful new facts, a dependency result or an explicit request; may resume funded work or only notify the mounted learning owner. No new quota; acknowledgement is not completed research", {}),
    binding("library_tool", "Use the public tool library; requests/configuration still obey original permissions and member ceilings", { command: { type: "object" } }, ["command"]),
    binding("library_expert", "Query/reuse/request/revise experts through the public library and separate creation/retention approval", { command: { type: "object" } }, ["command"]),
    binding("collaboration_feedback", `Record one evidence-based PA use feedback linked to an actual dispatched experience receipt. sourceRefs is required; summary must be at most ${EXPERIENCE_FEEDBACK_LIMITS.summaryMaxChars} characters.`, { feedback: EXPERIENCE_FEEDBACK_INPUT_SCHEMA }, ["feedback"]),
  ].map(binding => options.learningToolTimeoutMs === undefined ? binding : { ...binding, timeoutMs: options.learningToolTimeoutMs });
  return { snapshot: () => bindings, cancel: async () => {}, async execute(call, signal) {
    if (signal.aborted) return { outcome: "cancelled" };

    const args = call.arguments;

    try {
      let value: unknown;

      switch (call.name) {
        case "collaboration_inspect": {
          if (args.issueId !== undefined && !isPersonalAgentInspectionReference(args.issueId)
            || args.followUpAfterReceiptId !== undefined && !isPersonalAgentInspectionReference(args.followUpAfterReceiptId)) return invalid();
          value = await options.service.inspect(args.issueId === undefined && args.followUpAfterReceiptId === undefined ? undefined : {
            ...(args.issueId === undefined ? {} : { issueId: args.issueId }),
            ...(args.followUpAfterReceiptId === undefined ? {} : { followUpAfterReceiptId: args.followUpAfterReceiptId }),
          });
          break;
        }
        case "collaboration_report": {
          if (!text(args.problemKey) || !strings(args.facts, 1) || !strings(args.evidenceRefs, 0)
            || args.hypotheses !== undefined && !strings(args.hypotheses, 0)
            || args.issueId !== undefined && !text(args.issueId) || args.expectedRevision !== undefined && !integer(args.expectedRevision)) return invalid();

          const source = reportSources(args.evidenceRefs, options.sourceAddress);
          if (!source.ok) return { outcome: "error", code: source.reason, message: source.message };

          value = await options.service.report({ scope: options.scope, problemKey: args.problemKey,
            report: { reportId: call.toolCallId, source: { teamRunId: options.teamRunId ?? options.turnId,
              taskId: options.taskId ?? options.turnId, memberId: "personal_agent" },
              facts: args.facts, evidenceRefs: source.refs, ...(args.hypotheses === undefined ? {} : { hypotheses: args.hypotheses }) },
            ...(args.issueId === undefined ? {} : { issueId: args.issueId }), ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }) }, signal);
          break;
        }
        case "collaboration_decide": if (!decision(args)) return invalidDecision(args);value = await options.service.decide(args, signal);break;
        case "collaboration_capability": if (!text(args.dependencyId)) return invalid();value = await options.capability(args.dependencyId, signal);break;
        case "collaboration_resume": value = await options.service.resume(signal);break;
        case "library_tool": value = await options.library("tool", args.command, signal);break;
        case "library_expert": value = await options.library("expert", args.command, signal);break;
        case "collaboration_feedback": {
          const issues = experienceFeedbackInputIssues(args.feedback);
          if (issues.length) return { outcome: "error", code: "feedback_invalid", message: issues.map(issue => issue.message).join(" ") };
          value = await options.feedback(args.feedback);
          break;
        }
        default: return { outcome: "error", code: "unknown_tool", message: call.name };
      }

      // JSON round-trip is the transport boundary; library classes/executors never enter the model.
      const output = JSON.stringify(value);
      const wire: JsonValue = JSON.parse(output);

      return { outcome: "result", value: { result: wire }, output, truncated: false };
    } catch (error) { return { outcome: "error", code: "collaboration_command_failed", message: error instanceof Error ? error.message : "Collaboration command failed" }; }
  } };
}

function reportSourceSchema(sourceAddress: string | undefined): JsonObject {
  return sourceAddress === undefined ? { type: "array", items: { type: "string" } }
    : { type: "array", items: { type: "string" },
      description: "The host preserves the exact original session/turn source. Supply at most 31 other references, or up to 32 when that same source address is already included.",
      anyOf: [{ maxItems: REPORT_SOURCE_LIMIT - 1 }, { maxItems: REPORT_SOURCE_LIMIT, contains: { const: sourceAddress } }] };
}

/** Preserve every distinct supplied reference. Reserving one canonical source
 * slot is an explicit failure boundary, never a truncation or guessed address. */
function reportSources(refs: readonly string[], sourceAddress: string | undefined):
  { readonly ok: true; readonly refs: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly message: string } {
  if (sourceAddress === undefined) return { ok: true, refs };

  if (!isCoordinationDecisionSourceRefs([sourceAddress])) return { ok: false, reason: "collaboration_report_source_address_invalid",
    message: "The host source address is invalid; no report was recorded." };

  const combined = [...new Set([...refs, sourceAddress])];
  if (combined.length > REPORT_SOURCE_LIMIT) return { ok: false, reason: "collaboration_report_source_capacity",
    message: "Keep at most 31 other evidence references, or 32 including the exact host source address. No references were discarded and no report was recorded." };

  return { ok: true, refs: combined };
}

function binding(name: string, description: string, properties: JsonObject, required: string[] = []): ToolBinding {
  return { name, description, sideEffect: "read_only", parameters: { type: "object", properties, required, additionalProperties: false },
    needsApproval: false, timeoutMs: collaborationTimingFor(4).toolTimeoutMs, outputLimits: { maxBytes: 65536, maxLines: 500 } };
}

const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= TOOL_TEXT_MAX_CHARS;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const strings = (v: unknown, min: number): v is string[] => Array.isArray(v) && v.length >= min && v.length <= 32 && v.every(text);

function decision(v: JsonObject): v is JsonObject & PersonalAgentDecision {
  return text(v.inspectionId) && integer(v.expectedRevision) && isCoordinationAction({ kind: "decide", issueId: v.issueId,
    expectedRevision: v.expectedRevision, decision: v.decision, reason: v.reason, sourceRefs: v.sourceRefs });
}

function invalidDecision(v: JsonObject) {
  if (!isCoordinationDecisionReason(v.reason)) return invalid(`collaboration_decide.reason must be non-empty and at most ${COORDINATION_DECISION_LIMITS.reasonMaxChars} characters; summarize the decision instead of pasting long analysis.`);
  if (!isCoordinationDecisionSourceRefs(v.sourceRefs)) return invalid(`collaboration_decide.sourceRefs must contain 0-${COORDINATION_DECISION_LIMITS.maxSourceRefs} references of 1-${COORDINATION_DECISION_LIMITS.sourceRefMaxChars} characters each, all unique; use [] when none are known.`);
  return invalid(`collaboration_decide requires a non-empty inspectionId (max ${TOOL_TEXT_MAX_CHARS} chars), issueId (max ${COORDINATION_DECISION_LIMITS.issueIdMaxChars} chars), expectedRevision 1-${COORDINATION_DECISION_LIMITS.maxRevision}, and decision resolved|ordinary_execution|focused_learning.`);
}

function invalid(message = "Malformed collaboration arguments") { return { outcome: "error" as const, code: "invalid_collaboration_command", message }; }
