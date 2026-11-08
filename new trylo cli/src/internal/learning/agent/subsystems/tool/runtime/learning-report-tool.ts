import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { ToolBinding, ToolOutcome, ToolPort } from "../../../../../ports/tools.js";
import type { ToolGapRuntime } from "./awareness-runtime.js";
import { readToolTaskFeedback, toolTaskFeedbackContext } from "./tool-task-feedback.js";
import { recordAndScheduleToolTaskFeedback } from "./feedback-learning.js";
import { recordOf } from "../domain/evolution/parse.js";
import { readToolUsageContext } from "./usage-context.js";
import { readToolUsageGuidance } from "./usage-lessons.js";

const NAME = "tool_learning_report";
const BINDING: ToolBinding = {
  name: NAME, description: "Before choosing or revising a tool, operation=context with report:{query?:capability or tool ID,versionId?:asset version} retrieves scoped usage proposals and attributed feedback; check applicability before following them. Report meaningful tool opportunities or task feedback using actual call IDs. When the mounted catalog lacks a suitable capability before any call, report opportunity with toolCallIds:[] and explain the gap; the host must bind its actual captured catalog. This is a research hypothesis, not proven absence or a task oracle; do not make an unrelated call for evidence. Returned execution is not proven quality. operation=uses lists this session's version/use IDs. operation=opportunity takes report:{kind:opportunity,need,reason,tool?,toolCallIds,existingCapability:insufficient|configuration_sufficient|unknown,expectedBenefit?}. operation=feedback takes report:{versionId,useIds,situation,evidenceRefs,outcome:solved|partial|unsolved|unknown,attribution:implementation|usage|configuration|environment|unknown,summary,recommendation:retain|change_usage|improve|replace|avoid|unknown,observedMetrics?,baselineMetrics?}. Do not report every success. Reports cannot supply host task/catalog facts, approve, activate or stop a production tool.",
  sideEffect: "read_only", needsApproval: false, parallelSafe: false, timeoutMs: 10_000,
  outputLimits: { maxBytes: 12_000, maxLines: 100 },
  parameters: { type: "object", required: ["operation"], additionalProperties: false, properties: {
    operation: { type: "string", enum: ["uses", "context", "opportunity", "feedback"] }, report: { type: "object" },
  } },
};

type Options = { readonly runtime: ToolGapRuntime; readonly boardRoot: string; readonly workspaceId: string;
  readonly sessionId: string; readonly taskId: string; readonly now: () => number;
  readonly afterQueued?: (jobIds: readonly string[]) => void };

/** Trusted host identity and source override every model-supplied identity. */
export function createToolLearningReportTools(options: Options): ToolPort {
  return { snapshot: () => [structuredClone(BINDING)], cancel: async () => {}, async execute(call, signal) {
    if (signal.aborted) return { outcome: "cancelled" };

    if (call.name !== NAME || Object.keys(call.arguments).some(key => key !== "operation" && key !== "report")) return failure("invalid_tool_learning_report");

    try {
      const operation = call.arguments.operation;
      if (operation === "uses") {
        const loaded = await createBoardReader(options.boardRoot).load();
        if (!loaded.ok) return failure(loaded.reason);
        const uses = (loaded.state.toolUses ?? []).filter(record => record.sessionId === options.sessionId && record.workspaceId === options.workspaceId).slice(-32);
        return result({ uses: uses.map(record => ({ useId: record.useId, versionId: record.versionId, toolCallId: record.toolCallId,
          execution: record.execution, quality: record.quality })) });
      }

      const report = call.arguments.report;
      if (!recordOf(report)) return failure("invalid_tool_learning_report");

      if (operation === "context") {
        if (report.query !== undefined && (typeof report.query !== "string" || report.query.length > 512)) return failure("invalid_tool_learning_report");

        const usage = await readToolUsageContext(options.boardRoot, options.workspaceId, report.query);
        if (!usage.ok) return failure(usage.code);

        if (report.versionId === undefined) return result({ guidance: usage.guidance, feedback: usage.feedback, relevance: usage.relevance });

        if (typeof report.versionId !== "string") return failure("invalid_tool_learning_report");

        const loaded = await createBoardReader(options.boardRoot).load();
        if (!loaded.ok) return failure(loaded.reason);

        if (!(loaded.state.toolUses ?? []).some(use => use.versionId === report.versionId && use.workspaceId === options.workspaceId)) return failure("tool_feedback_scope_mismatch");

        const feedback = await readToolTaskFeedback(options.boardRoot, report.versionId, options.workspaceId);
        if (!feedback.ok) return failure(feedback.code);

        const lessons = await readToolUsageGuidance(options.boardRoot, report.versionId, options.workspaceId);

        return lessons.ok ? result({ versionId: report.versionId, guidance: usage.guidance, feedback: usage.feedback, usageLessons: lessons.lessons,
          taskFeedback: toolTaskFeedbackContext(feedback.records) ?? "No task feedback." }) : failure(lessons.code);
      }

      if (operation === "opportunity") {
        const accepted = await options.runtime.reportOpportunity({ turnId: options.taskId, reportId: call.toolCallId, source: "model", report });
        if (accepted.kind === "accepted") options.afterQueued?.([]);
        return result(accepted);
      }

      if (operation !== "feedback") return failure("invalid_tool_learning_report");

      const loaded = await createBoardReader(options.boardRoot).load();
      if (!loaded.ok) return failure(loaded.reason);

      if (!Array.isArray(report.useIds) || report.useIds.some(id => !(loaded.state.toolUses ?? []).some(use => use.useId === id
        && use.workspaceId === options.workspaceId && use.sessionId === options.sessionId))) return failure("tool_feedback_scope_mismatch");

      const recorded = await recordAndScheduleToolTaskFeedback(options.boardRoot, { ...report, schemaVersion: 1, feedbackId: call.toolCallId,
        sessionId: options.sessionId, taskId: options.taskId, source: "model" }, new Date(options.now()).toISOString());
      if (recorded.ok && recorded.learning.kind === "queued") options.afterQueued?.([recorded.learning.jobId]);

      return recorded.ok ? result(recorded) : failure(recorded.code);
    } catch {
      return failure("tool_learning_recording_unavailable");
    }
  } };
}

function result(value: JsonObject): ToolOutcome { return { outcome: "result", value, output: JSON.stringify(value), truncated: false }; }

function failure(code: string): ToolOutcome { return { outcome: "error", code, message: code }; }
