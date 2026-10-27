import type { ToolBinding, ToolPort } from "../ports/tools.js";
import type { SubagentObservation } from "../protocol/subagent-observation.js";

export const MEMBER_REPORTING_INSTRUCTIONS = `Use report_progress to keep the user informed in their language. Report once when work starts, then only at a meaningful milestone, blocker, or handoff. Each report is 1-3 short sentences: what changed, what remains or happens next. Do not echo task prompts, role/system instructions, raw logs, tool payloads, or internal verification templates. Distinguish your observations from verified outcomes. A ready report means ready for the next step, never independent acceptance. Do not invent facts. Continue to keep your full technical answer in the member conversation. This reporting channel changes no permissions or team direction.`;

const binding: ToolBinding = { name: "report_progress", description: "Publish a concise user-facing progress update for this member's assigned task. No execution or approval authority.",
  sideEffect: "read_only", needsApproval: false, parallelSafe: true, timeoutMs: 1000, outputLimits: { maxBytes: 256, maxLines: 3 },
  parameters: { type: "object", additionalProperties: false, properties: {
    state: { type: "string", enum: ["progress", "blocked", "ready"] },
    message: { type: "string", minLength: 1, maxLength: 1200, description: "1-3 short sentences for the user; facts, next step or blocker, no internal prompts." },
  }, required: ["state", "message"] } };

/** A communication port around already-bounded tools; it grants no world access. */
export function withMemberReporting(tools: ToolPort, publish: (event: SubagentObservation) => void, round: () => number): ToolPort {
  return {
    snapshot: () => [...tools.snapshot().filter(tool => tool.name !== binding.name), binding],
    execute: async (call, signal) => {
      if (call.name !== binding.name) return tools.execute(call, signal);
      if (signal.aborted) return { outcome: "cancelled" };
      const { state, message } = call.arguments;
      if ((state !== "progress" && state !== "blocked" && state !== "ready") || typeof message !== "string" || !message.trim() || message.length > 1200) {
        return { outcome: "error", code: "invalid_progress_report", message: "Provide state progress/blocked/ready and a nonempty message of at most 1200 characters." };
      }
      publish({ id: call.toolCallId, round: round(), kind: "report", reportState: state, text: message.trim() });
      return { outcome: "result", value: { published: true }, output: "Progress report published.", truncated: false };
    },
    cancel: id => tools.cancel(id),
  };
}
