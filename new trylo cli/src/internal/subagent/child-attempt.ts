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
export function requireCompletedChild(terminalReason: string | undefined): void {
  if (terminalReason === "completed") return;
  const error = new Error(`Child attempt failed with terminal reason: ${terminalReason ?? "unknown"}`);
  (error as { code?: string }).code = terminalReason ?? "child_attempt_failed";
  throw error;
}

export function createChildAttemptWorker(
  options: ChildAttemptFactoryOptions,
): SubagentWorker<ChildAttemptResult> {
  return async (context: SubagentContext): Promise<ChildAttemptResult> => {
    // 1. Build child ports using existing parent ports + context.tools (already bounded)
    const childPorts: LoopPorts = {
      provider: options.provider,
      tools: context.tools, // already wrapped by createSubagentToolBoundary!
      permission: options.permission,
      profile: options.profile ?? DEFAULT_PROFILE_PORT,
      ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
      ...(options.grants !== undefined ? { grants: options.grants } : {}),
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

    // 4. Record usage in subagent governance (triggers budget ceiling if exceeded)
    context.recordUsage(result.usage.inputTokens, result.usage.outputTokens);

    // 5. Extract output and report progress
    const output = extractAssistantText(result.transcript);
    const terminalReason = result.state.terminalReason;
    const isCompleted = terminalReason === "completed";

    context.reportProgress(
      isCompleted ? "Child attempt completed" : `Child attempt ended: ${terminalReason ?? "unknown"}`,
      100,
    );

    requireCompletedChild(terminalReason);

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
