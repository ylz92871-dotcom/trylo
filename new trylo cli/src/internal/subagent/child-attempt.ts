import { EMPTY_PROFILE, type ProfilePort } from "../contract/profile.js";
import type { Message } from "../contract/execution.js";
import type { IterationBudget } from "../domain/iteration.js";
import type { PermissionGrantCache } from "../loop/permission-grants.js";
import { runTurn, type LoopPorts, type RunTurnRequest, type RunTurnResult } from "../loop/runner.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderPort, ProviderUsage } from "../ports/provider.js";
import type { ToolSandbox } from "../ports/tools.js";
import type { Envelope } from "../protocol/envelope.js";
import type { Transcript } from "../protocol/transcript.js";
import type { SubagentContext, SubagentWorker } from "./types.js";
import { createGovernedChildProvider } from "./child-provider.js";
import { inheritedGrantView, SUBAGENT_PERMISSION } from "./inherited-authority.js";

/**
 * ChildAttemptWorker — Subagent Real Executor backed by re-entering the existing loop.
 *
 * Implements Design Decision D1:
 * "Real executor = re-enter the same engine, absolutely NO second loop.
 * Subagent = a nested child instance of the existing Engine/turn runner,
 * fed: child task prompt + SA tool boundary (createSubagentToolBoundary) + budget + cancelSignal + child lineage."
 */

export type ChildAttemptFactoryOptions = {
  readonly callerMessages?: ReadonlyArray<Message>;
  readonly provider: ProviderPort;
  readonly permission: PermissionPort;
  readonly execPolicy?: LoopPorts["execPolicy"];
  readonly profile?: ProfilePort | undefined;
  readonly sandbox?: ToolSandbox | undefined;
  readonly grants?: PermissionGrantCache | undefined;
  readonly sessionId?: string | undefined;
  readonly model?: string | undefined;
  readonly budget?: IterationBudget | undefined;
  readonly prompt: string;
  readonly onEnvelope?: ((envelope: Envelope) => void) | undefined;
};

export type ChildAttemptResult = {
  readonly status: "completed" | "failed";
  readonly terminalReason: string | undefined;
  readonly output: string;
  readonly usage: ProviderUsage;
  readonly transcript: Transcript;
  readonly envelopes: ReadonlyArray<Envelope>;
};

export const DEFAULT_PROFILE_PORT: ProfilePort = {
  async load() {
    return EMPTY_PROFILE;
  },
};

export function extractAssistantText(transcript: Transcript): string {
  const chunks: string[] = [];
  for (const item of transcript) {
    if (item.kind === "assistant_text") {
      chunks.push(item.text);
    }
  }
  return chunks.join("");
}

/** A round report excludes replies inherited from earlier turns or a fork. */
export function extractLatestAssistantText(transcript: Transcript): string {
  let start = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.kind === "user") {
      start = index + 1;
      break;
    }
  }
  return extractAssistantText(transcript.slice(start));
}

/** Both child executor shapes must reject a failed engine terminal. */
export function requireCompletedChild(result: Pick<RunTurnResult, "state" | "inputs">): void {
  const terminalReason = result.state.terminalReason;
  if (terminalReason === "completed") return;
  const failure = [...result.inputs].reverse().find(input =>
    input.type === "transport_fail" || input.type === "transport_unknown" || input.type === "budget_exhausted"
    || input.type === "tool_failed" || input.type === "tool_unknown" || input.type === "tool_rejected"
    || input.type === "permission_denied" || input.type === "permission_failed" || input.type === "permission_expired");
  let code: string = terminalReason ?? "child_attempt_failed";
  let message = `Child attempt failed with terminal reason: ${terminalReason ?? "unknown"}`;
  if (failure?.type === "transport_fail" || failure?.type === "transport_unknown") {
    code = failure.errorClass ?? failure.type;
    message = failure.message;
  } else if (failure?.type === "budget_exhausted") {
    code = failure.reason;
    message = `Child attempt exhausted ${failure.reason}`;
  } else if (failure?.type === "tool_failed" || failure?.type === "tool_unknown") {
    code = failure.type;
    message = failure.message;
  } else if (failure?.type === "tool_rejected") {
    code = failure.code;
    message = failure.message;
  } else if (failure?.type === "permission_denied" || failure?.type === "permission_expired" || failure?.type === "permission_failed") {
    code = "subagent_permission_denied";
    message = "The child has no usable parent approval for this call; grant the exact action in the parent before delegating it";
  }
  const error = new Error(message);
  (error as { code?: string }).code = code;
  throw error;
}

export function createChildAttemptWorker(
  options: ChildAttemptFactoryOptions,
): SubagentWorker<ChildAttemptResult> {
  return async (context: SubagentContext): Promise<ChildAttemptResult> => {
    const grants = inheritedGrantView(context.inheritedGrants ?? options.grants);
    // 1. Build child ports using existing parent ports + context.tools (already bounded)
    const childPorts: LoopPorts = {
      provider: createGovernedChildProvider(options.provider, context),
      tools: context.tools, // already wrapped by createSubagentToolBoundary!
      permission: SUBAGENT_PERMISSION,
      profile: options.profile ?? DEFAULT_PROFILE_PORT,
      ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
      ...(grants === undefined ? {} : { grants }),
      ...(options.execPolicy === undefined ? {} : { execPolicy: options.execPolicy }),
    };

    // 2. Build child run request attributing to rootAttemptId
    const childTurnId = `trn-sub-${context.subagentId}`;
    const childRequest: RunTurnRequest = {
      sessionId: options.sessionId ?? "subagent-session",
      turnId: childTurnId,
      correlationId: context.lineage.rootAttemptId,
      text: options.prompt,
      ...(options.callerMessages === undefined ? {} : { callerMessages: options.callerMessages }),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
      cancelSignal: context.signal,
      onEnvelope: (env) => {
        const stamped: Envelope = {
          ...env,
          attemptId: context.lineage.rootAttemptId,
        };
        options.onEnvelope?.(stamped);
      },
    };

    // 3. Re-enter the existing turn loop (D1: NO second loop)
    const result: RunTurnResult = await runTurn(childPorts, childRequest);

    // Usage has already been charged once per provider response, not per turn.
    // Extract output and report progress.
    const output = extractAssistantText(result.transcript);
    const terminalReason = result.state.terminalReason;
    const isCompleted = terminalReason === "completed";

    context.reportProgress(
      isCompleted ? "Child attempt completed" : `Child attempt ended: ${terminalReason ?? "unknown"}`,
      100,
    );

    requireCompletedChild(result);

    return {
      status: "completed",
      terminalReason,
      output,
      usage: result.usage,
      transcript: result.transcript,
      envelopes: result.envelopes,
    };
  };
}
