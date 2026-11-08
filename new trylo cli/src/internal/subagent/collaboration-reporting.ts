import type { ToolBinding, ToolPort } from "../ports/tools.js";
import type { SubagentObservation } from "../protocol/subagent-observation.js";
import { withMemberReporting } from "./user-progress.js";
import type { MemberCollaborationReport } from "../protocol/member-collaboration-report.js";
import type { TimerScheduler } from "./scheduler.js";

export type { MemberCollaborationReport as CollaborationMemberReport } from "../protocol/member-collaboration-report.js";

const dimensions = ["decomposition", "assignment", "handoff", "synchronization", "information_sharing", "review", "waiting", "rework"];
const binding: ToolBinding = { name: "report_collaboration_observation", sideEffect: "read_only", needsApproval: false,
  parallelSafe: true, timeoutMs: 1000, outputLimits: { maxBytes: 512, maxLines: 4 },
  description: "Publish a bounded collaboration observation to the parent. Reviewer/verifier assessments remain peer claims, never external verification. Cite actual tool:<toolCallId> or supplied evidence refs. Optional operation sends a real context request, synchronization, or reference-sharing notification; attach learning_action_id only when actually following a displayed action.",
  parameters: { type: "object", additionalProperties: false, properties: {
    dimension: { type: "string", enum: dimensions }, summary: { type: "string", minLength: 1, maxLength: 1200 },
    evidence_refs: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } },
    operation: { type: "string", enum: ["request_context", "synchronize", "share_reference"] },
    learning_action_id: { type: "string", minLength: 1, maxLength: 200 },
  }, required: ["dimension", "summary", "evidence_refs"] } };

/** Compatibility only: translate old arguments into the normal progress mailbox.
 * Retain while existing callers use this tool; new reports use report_progress.
 */
export function withCollaborationReporting(tools: ToolPort, publish: (event: SubagentObservation) => void,
  round: () => number, report: (value: MemberCollaborationReport) => Promise<void>, scheduler?: TimerScheduler): ToolPort {
  const progress = withMemberReporting(tools, publish, round, { report, ...(scheduler === undefined ? {} : { scheduler }) });
  return { snapshot: () => [...progress.snapshot().filter(tool => tool.name !== binding.name), binding], cancel: id => progress.cancel(id),
    async execute(call, signal) {
      if (call.name !== binding.name) return progress.execute(call, signal);

      if (signal.aborted) return { outcome: "cancelled" };

      const { dimension, summary, evidence_refs: refs, operation, learning_action_id: actionId } = call.arguments;

      if (typeof dimension !== "string" || !dimensions.includes(dimension) || typeof summary !== "string" || !summary.trim() || summary.length > 1200
        || !Array.isArray(refs) || refs.length > 16 || !refs.every(ref => typeof ref === "string" && ref.length > 0 && ref.length <= 512)
        || (operation !== undefined && operation !== "request_context" && operation !== "synchronize" && operation !== "share_reference")
        || (actionId !== undefined && (typeof actionId !== "string" || !actionId || actionId.length > 200))) {
        return { outcome: "error", code: "invalid_collaboration_report", message: "Provide a collaboration dimension, concise observation and bounded actual evidence refs." };
      }

      const text = operation === "share_reference" ? `${summary.trim()}\n共享引用：\n${refs.join("\n")}` : summary.trim();
      if (operation === "share_reference" && (refs.length === 0 || text.length > 1200)) return { outcome: "error",
        code: "invalid_shared_references", message: "Share explicit references and keep the combined notification within 1200 characters." };

      const result = await progress.execute({ ...call, name: "report_progress", arguments: {
        state: operation === "request_context" ? "blocked" : "progress", message: text,
        collaboration: { summary: summary.trim(),
          facts: ["A member submitted this legacy-format summary; its observations and hypotheses are not separately classified."],
          suspectedCauses: [], evidenceRefs: refs, dimension,
          ...(operation === undefined ? {} : { operation }), ...(typeof actionId === "string" ? { learningActionId: actionId } : {}) },
      } }, signal);

      return result.outcome !== "result" ? result : { ...result, value: { published: true, verification: "peer_claim" },
        output: "Observation delivered to the parent; it is not independent acceptance." };
    } };
}
