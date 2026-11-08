import type { ToolPort } from "../../ports/tools.js";
import type { JsonValue } from "../../protocol/envelope.js";
import type { CentralLearningTurnRuntime } from "./central-learning-turn.js";
import { CENTRAL_RESPONSE_PAGE_BYTES, createCentralLearningResponses } from "./central-learning-responses.js";
import { MAX_TOOL_OUTPUT_BYTES } from "../../loop/tool-execution.js";

/** The tool catalog follows the actual turn owner; explicit legacy content
 * coordination remains available through its original entry. */
export function centralLearningTools(runtime: Omit<CentralLearningTurnRuntime, "tools" | "wrapControlTools">,
  options: { readonly independent?: boolean } = {}):
  Pick<CentralLearningTurnRuntime, "tools" | "wrapControlTools"> {
  const independent = options.independent === true;
  const operations = independent ? ["inspect", "read_response", "resume", "read_advisory", "report_advisory_use"]
    : ["inspect", "begin_content", "apply_known", "residual_review", "read_material", "read_response", "resume", "read_advisory", "report_advisory_use"];
  const responses = createCentralLearningResponses();

  function result(value: unknown, toolCallId: string) {
    const output = responses.render(value, toolCallId);
    const wire: JsonValue = JSON.parse(output);
    return { outcome: "result" as const, value: { result: wire }, output, truncated: false };
  }

  const tools: ToolPort = { snapshot: () => [{ name: "central_learning", sideEffect: "read_only", needsApproval: false,
    description: (independent
      ? "Independent background learning. inspect reads the owner status and a separate bounded public checkpoint: learning goals, residuals, committed next steps or waits and source references. These observations are not atomic; a recorded next step is not proof of execution. resume notifies the owner after meaningful new information or an explicit user request; its acknowledgement does not mean research finished. Continue the user's work after reporting an opportunity. read_response reads pages of an existing response."
      : "Unified learning. inspect shows the shared pool and actual stage results. begin_content(issueId) retrieves the focused original requirements/experience/known answers. Complete the returned apply_known instruction, submit applicationJson, then complete residual_review and submit reviewJson. The host validates/persists these results and allocates/dispatches the real subsystem when residual learning remains. Never invent gains, source quotes, grants, approvals or completed work. resume reconsiders actual focused stages after new facts.")
      + " read_advisory(ref,version,start?,maximumChars?) reads the original advisory selected for this task. report_advisory_use(ref,version,change,reason) records your explicit public choice after the exact version was delivered or fully read in this turn. State the actual change you made and why its original conditions apply. This declaration does not prove execution, benefit or quality. It only records internal learning metadata and never changes workspace files, permissions or task behavior.",
    parameters: { type: "object", additionalProperties: false, required: ["operation"], properties: {
      operation: { type: "string", enum: operations },
      ref: { type: "string" }, version: { type: "string" }, change: { type: "string", minLength: 1, maxLength: 2000 },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      ...(independent ? { maximumChars: { type: "integer", minimum: 2, maximum: 8192 } } : {}),
      ...(independent ? {} : {
        issueId: { type: "string" }, domain: { type: "string", enum: ["prompt", "tool", "workflow", "collaboration", "skill"] },
        stageRef: { type: "string" }, inputHash: { type: "string" }, applicationJson: { type: "string" }, reviewJson: { type: "string" },
        evidenceRef: { type: "string" }, maximumChars: { type: "integer", minimum: 2, maximum: 8192 },
      }),
      start: { type: "integer", minimum: 0 },
      responseRef: { type: "string" }, maximumBytes: { type: "integer", minimum: 4, maximum: CENTRAL_RESPONSE_PAGE_BYTES },
    } }, timeoutMs: 600000, outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES, maxLines: 4000 } }], cancel: async () => {},

    async execute(call, signal) {
      if (signal.aborted) return { outcome: "cancelled" };

      if (call.name !== "central_learning") return { outcome: "error", code: "unknown_tool", message: call.name };

      try {
        const args = call.arguments;
        if (independent && !operations.includes(String(args.operation))) return {
          outcome: "error", code: "central_learning_operation_unavailable",
          message: "This turn uses independent background learning. Inspect its status or notify the owner after meaningful new information.",
        };

        const value = args.operation === "read_response" && typeof args.responseRef === "string"
          ? responses.read(args.responseRef, typeof args.start === "number" ? args.start : undefined,
            typeof args.maximumBytes === "number" ? args.maximumBytes : undefined, call.toolCallId)
          : await runtime.command(args, signal, call.toolCallId);

        return result(value, call.toolCallId);
      } catch (error) {
        return { outcome: "error", code: "central_learning_failed", message: error instanceof Error ? error.message : "Central learning unavailable" };
      }
    } };

  return { tools, wrapControlTools: port => ({ ...port, async execute(call, signal) {
    const outcome = await port.execute(call, signal);
    if (outcome.outcome !== "result") return outcome;

    try {
      // PA focus can carry the same content requests. Its pages must use this
      // turn's one reader, preserving the original successful action receipt.
      return result(JSON.parse(outcome.output), call.toolCallId);
    } catch (error) {
      return { outcome: "error", code: "central_learning_response_failed",
        message: error instanceof Error ? error.message : "Inspect original state before retrying" };
    }
  } }) };
}
