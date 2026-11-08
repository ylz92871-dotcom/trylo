import type { ToolBinding, ToolPort } from "../ports/tools.js";
import type { SubagentObservation } from "../protocol/subagent-observation.js";
import { MEMBER_COLLABORATION_CONTENT_SCHEMA, parseMemberCollaborationReport,
  type MemberCollaborationReport } from "../protocol/member-collaboration-report.js";
import { observeOptional } from "./optional-observer.js";
import type { TimerScheduler } from "./scheduler.js";

export const MEMBER_REPORTING_INSTRUCTIONS = `Use report_progress to keep the user informed in their language. Report once when work starts, then only at a meaningful milestone, blocker, or handoff. Each report is 1-3 short sentences: what changed, what remains or happens next.
Read the task goal, original assignment, actual progress and workload, blockers, dependencies, available tools and member configuration from the current context. Interpret those facts yourself.
When coordination needs attention, attach a brief collaboration object to your normal report: summary, facts (observations), suspectedCauses (hypotheses, possibly empty), evidenceRefs (available references, possibly empty), and issueRef when adding information to an existing issue. You may proactively report when needed; do not wait to prove a cause or collect complete references.
Do not run a separate reflection after every model call, tool result or handoff. The Personal Agent decides whether a report is resolved, needs ordinary coordination, or should become focused learning.
Current explicit user instructions take priority. Stay within your assigned role, tools and permissions; reporting does not authorize changing the team or another member's configuration.
Do not echo task prompts, role/system instructions, raw logs, secrets or hidden reasoning. A ready report means ready for the next step, never independent acceptance. Continue to keep your full technical answer in the member conversation. Reporting changes no permissions, execution state or team direction.`;

const binding: ToolBinding = { name: "report_progress", description: "Publish a concise user-facing progress update for this member's assigned task. No execution or approval authority.",
  sideEffect: "read_only", needsApproval: false, parallelSafe: true, timeoutMs: 1000, outputLimits: { maxBytes: 256, maxLines: 3 },
  parameters: { type: "object", additionalProperties: false, properties: {
    state: { type: "string", enum: ["progress", "blocked", "ready"] },
    message: { type: "string", minLength: 1, maxLength: 1200, description: "1-3 short sentences for the user; facts, next step or blocker, no internal prompts." },
    collaboration: MEMBER_COLLABORATION_CONTENT_SCHEMA,
  }, required: ["state", "message"] } };

/** A communication port around already-bounded tools; it grants no world access. */
export function withMemberReporting(tools: ToolPort, publish: (event: SubagentObservation) => void, round: () => number,
  observer?: { readonly report: (report: MemberCollaborationReport) => Promise<void>; readonly scheduler?: TimerScheduler }): ToolPort {
  return {
    snapshot: () => [...tools.snapshot().filter(tool => tool.name !== binding.name), binding],
    execute: async (call, signal) => {
      if (call.name !== binding.name) return tools.execute(call, signal);

      if (signal.aborted) return { outcome: "cancelled" };

      const { state, message } = call.arguments;

      if ((state !== "progress" && state !== "blocked" && state !== "ready") || typeof message !== "string" || !message.trim() || message.length > 1200) {
        return { outcome: "error", code: "invalid_progress_report", message: "Provide state progress/blocked/ready and a nonempty message of at most 1200 characters." };
      }

      const collaboration = call.arguments.collaboration === undefined ? undefined : parseMemberCollaborationReport(call.arguments.collaboration, call.toolCallId);
      if (call.arguments.collaboration !== undefined && collaboration === undefined) return { outcome: "error", code: "invalid_collaboration_report",
        message: "Provide a short summary and observed facts; suspected causes and references may be empty." };

      publish({ id: call.toolCallId, round: round(), kind: "report", reportState: state, text: message.trim(),
        ...(collaboration === undefined ? {} : { collaboration }) });

      if (collaboration !== undefined && observer !== undefined) {
        // The mailbox already owns delivery. A failing/late optional consumer
        // cannot change this publication, tool result, or the member's state.
        await observeOptional(() => observer.report(structuredClone(collaboration)), observer.scheduler, signal);
      }

      return { outcome: "result", value: { published: true }, output: "Progress report published.", truncated: false };
    },
    cancel: id => tools.cancel(id),
  };
}
