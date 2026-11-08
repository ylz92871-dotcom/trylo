import { EMPTY_PROFILE, type ProfilePort } from "../contract/profile.js";
import type { IterationBudget } from "../domain/iteration.js";
import { runTurn, type LoopPorts } from "../loop/runner.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ToolSandbox } from "../ports/tools.js";
import type { ProviderMessage, ProviderPort, ProviderUsage } from "../ports/provider.js";
import { acknowledgesProviderResponse } from "../ports/provider-response.js";
import { emptyUsage } from "../ports/provider.js";
import type { Envelope } from "../protocol/envelope.js";
import type { Message } from "../contract/execution.js";
import type { CompactWindow } from "../ports/compaction.js";
import type { Transcript } from "../protocol/transcript.js";
import { DEFAULT_PROFILE_PORT, extractLatestAssistantText, requireCompletedChild } from "./child-attempt.js";
import type { SubagentContext, SubagentWorker } from "./types.js";
import { createGovernedChildProvider } from "./child-provider.js";
import { forkBackgroundMessages } from "./fork-context.js";
import { childCompaction } from "./context-budget.js";
import { createChildProviderSession, type ChildProviderSession } from "./child-provider-session.js";
import { systemTimerScheduler, type TimerScheduler } from "./scheduler.js";
import { inheritedPermission } from "./inherited-authority.js";
import { subagentToolActivity } from "../protocol/subagent-activity.js";
import type { SubagentApprovalScope } from "./parent-approval.js";
import { createSubagentObserver, type SubagentObservation } from "../protocol/subagent-observation.js";
import { MEMBER_REPORTING_INSTRUCTIONS, withMemberReporting } from "./user-progress.js";
import { REPRESENTATION_REPORTING_INSTRUCTIONS, withRepresentationReporting } from "./representation-reporting.js";
import type { TeamRepresentation } from "../protocol/team-representation.js";
import type { SubagentInput } from "./input-channel.js";
import type { SubagentHandoff } from "../protocol/subagent-handoff.js";
import { withCollaborationReporting, type CollaborationMemberReport } from "./collaboration-reporting.js";

/**
 * The worker behind the multi-agent control tools (WP22.2 / C43, L29).
 *
 * `createChildAttemptWorker` runs one turn and returns. That is exactly right
 * for `delegate_subagent` and exactly wrong for an agent the parent intends to
 * keep talking to, so this is the second shape: it keeps re-entering the same
 * loop, carrying the previous round forward, until the channel closes or the
 * run is cancelled.
 *
 * A round resumes the Loop's canonical transcript and compaction window.
 * Forked parent history is a pinned background input to the same prompt view,
 * preserving image bytes and tool pairs while participating in the hard gate.
 * It is never appended to an already-budgeted provider request.
 */

export type InteractiveChildOptions = {
  readonly onExecutionEnvelope?: (event: Envelope) => void;
  readonly onRequestUsage?: (requestId: string) => void;
  readonly onCollaborationReport?: (report: CollaborationMemberReport, requestId?: string, requestSequence?: number) => Promise<void>;
  readonly onRequestDispatched?: (round: number, requestId: string, request: import("../ports/provider.js").ProviderRequest) => Promise<void>;
  readonly prepareRound?: (round: number, prompt: string, handoff: SubagentHandoff | undefined, signal: AbortSignal,
    dependencies?: readonly string[]) => Promise<string | undefined>;
  readonly onRoundDispatched?: (round: number, requestId: string, guidance: string | undefined) => Promise<void>;
  readonly initialHandoff?: SubagentHandoff;
  readonly approvalScope?: SubagentApprovalScope;
  readonly providerSession?: ChildProviderSession;
  readonly callerMessages?: ReadonlyArray<Message>;
  readonly forkWindow?: CompactWindow;
  readonly provider: ProviderPort;
  readonly permission: PermissionPort;
  readonly execPolicy?: LoopPorts["execPolicy"];
  readonly sandbox?: ToolSandbox;
  readonly profile?: ProfilePort | undefined;
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  /** The first instruction. Every later one arrives over the channel. */
  readonly message: string;
  /**
   * The parent's conversation, for `fork_context` (L29). Absent means the agent
   * starts from nothing but its own first instruction.
   */
  readonly forkMessages?: ReadonlyArray<ProviderMessage> | undefined;
  /**
   * A transcript to resume from, already in the loop's own shape. This is how
   * `resume_agent` brings an agent back: the run it continues is not the one it
   * was, so the conversation has to be handed over rather than reopened.
   */
  readonly forkTranscript?: Transcript | undefined;
  readonly onEnvelope?: ((envelope: Envelope) => void) | undefined;
  readonly budget?: IterationBudget | undefined;
  readonly onRoundStarted?: ((round: number, prompt: string, receipt?: SubagentInput["receipt"]) => void | Promise<void>) | undefined;
  readonly initialSubmission?: SubagentInput["receipt"];
  readonly onCheckpoint?: ((transcript: Transcript, window: CompactWindow | undefined, phase: "round_ready" | "interrupted", round: number) => void | Promise<void>) | undefined;
  readonly onRoundReady?: ((result: InteractiveChildResult) => void | Promise<void>) | undefined;
  readonly onProgressReport?: (report: SubagentObservation) => void;
  readonly onRepresentation?: (value: TeamRepresentation, round: number) => Promise<boolean>;
  readonly formatOutput?: (round: number, text: string) => string;
  readonly idleTimeoutMs?: number | undefined;
  readonly onIdle?: (() => void) | undefined;
  readonly isParked?: (() => boolean) | undefined;
  readonly scheduler?: TimerScheduler | undefined;
};

export type InteractiveChildResult = {
  readonly status: "completed";
  readonly output: string;
  /** How many turns this agent ran. `1` for an agent nobody ever followed up. */
  readonly rounds: number;
  readonly usage: ProviderUsage;
  readonly transcript: Transcript;
  readonly promptView?: CompactWindow;
  readonly envelopes: ReadonlyArray<Envelope>;
  readonly parked?: boolean | undefined;
};

function addUsage(left: ProviderUsage, right: ProviderUsage): ProviderUsage {
  return {
    mode: left.mode,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function createInteractiveChildWorker(
  options: InteractiveChildOptions,
): SubagentWorker<InteractiveChildResult> {
  const background = forkBackgroundMessages(options.forkMessages ?? []);
  const callerMessages = options.callerMessages === undefined ? undefined : structuredClone(options.callerMessages);

  return async (context: SubagentContext): Promise<InteractiveChildResult> => {
    let observationRound = 1;
    const publish = (event: SubagentObservation): void => {
      context.reportObservation?.(event);
      if (event.kind === "report") options.onProgressReport?.(event);
    };
    const observe = createSubagentObserver(publish);
    const approval = options.approvalScope?.bind(context);
    const execPolicy = approval?.execPolicy ?? options.execPolicy;
    const session = options.providerSession ?? createChildProviderSession(options.provider, background, options.model);
    let roundGuidance: string | undefined;
    let dispatchedRound = 0;
    let requestSequence = 0;
    let currentRequest: { readonly requestId: string; readonly sequence: number } | undefined;
    const boundaryProvider: ProviderPort = options.onRoundDispatched === undefined && options.onRequestDispatched === undefined
      && options.onRequestUsage === undefined && options.onCollaborationReport === undefined ? session.provider : {
      ...(session.provider.inputBindingDigest === undefined ? {} : { inputBindingDigest: request => session.provider.inputBindingDigest!(request) }),
      ...(session.provider.prepareRequest === undefined ? {} : { prepareRequest: (request, signal) => session.provider.prepareRequest!(request, signal) }),
      ...(session.provider.continuation === undefined ? {} : { continuation: session.provider.continuation }),
      async *stream(request, signal) {
        currentRequest = { requestId: request.attemptId, sequence: ++requestSequence };
        let requestDispatched = false;

        for await (const event of session.provider.stream(request, signal)) {
          if (event.type === "usage") options.onRequestUsage?.(request.attemptId);

          const acknowledged = acknowledgesProviderResponse(event);
          if (!requestDispatched && !signal.aborted && acknowledged) {
            requestDispatched = true;
            await options.onRequestDispatched?.(observationRound, request.attemptId, request);
          }

          if (dispatchedRound !== observationRound && !signal.aborted && acknowledged) {
            dispatchedRound = observationRound;
            const sent = roundGuidance !== undefined && request.messages.some(message =>
              message.role === "system" && message.content === roundGuidance) ? roundGuidance : undefined;
            await options.onRoundDispatched?.(observationRound, request.attemptId, sent);
          }

          yield event;
        }
      },
    };
    const reporting = options.onCollaborationReport === undefined ? withMemberReporting(context.tools, publish, () => observationRound)
      : withCollaborationReporting(context.tools, publish, () => observationRound, report => {
        const request = currentRequest;
        return options.onCollaborationReport!(report, request?.requestId, request?.sequence);
      }, options.scheduler);
    const childPorts: LoopPorts = {
      provider: createGovernedChildProvider(boundaryProvider, context),
      compaction: childCompaction(session.provider),
      // Already bounded by the runtime to what this subagent may touch.
      tools: options.onRepresentation === undefined ? reporting
        : withRepresentationReporting(reporting, value => options.onRepresentation!(value, observationRound)),
      permission: approval?.permission ?? inheritedPermission(options.permission),
      ...(context.inheritedGrants === undefined ? {} : { grants: context.inheritedGrants }),
      ...(execPolicy === undefined ? {} : { execPolicy }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      profile: options.profile ?? DEFAULT_PROFILE_PORT,
    };

    const forked = options.forkTranscript ?? [];
    let carried: Transcript = forked;
    let prompt = options.message;
    let receipt = options.initialSubmission;
    let handoff = options.initialHandoff;
    let dependencies: readonly string[] | undefined;
    let transcript: Transcript = [];
    let envelopes: ReadonlyArray<Envelope> = [];
    let usage: ProviderUsage = emptyUsage("snapshot");
    let rounds = 0;
    let window = options.forkWindow;

    try {
      for (;;) {
        observationRound = rounds + 1;
        context.setActivity?.("working");
        await options.onRoundStarted?.(rounds + 1, prompt, receipt);

        if (context.signal.aborted) break;

        roundGuidance = await options.prepareRound?.(rounds + 1, prompt, handoff, context.signal, dependencies);

        if (context.signal.aborted) break;

        const result = await runTurn(childPorts, {
          sessionId: options.sessionId ?? "subagent-session",
          turnId: `trn-sub-${context.subagentId}-r${rounds + 1}`,
          correlationId: context.lineage.rootAttemptId,
          text: prompt,
          cancelSignal: context.signal,
          ...(options.budget === undefined ? {} : { budget: options.budget }),
          callerMessages: [...(callerMessages ?? []), { role: "system", content: MEMBER_REPORTING_INSTRUCTIONS },
            ...(roundGuidance === undefined ? [] : [{ role: "system" as const, content: roundGuidance }]),
            ...(options.onRepresentation === undefined ? [] : [{ role: "system" as const, content: REPRESENTATION_REPORTING_INSTRUCTIONS }])],
          ...(background.length === 0 ? {} : { backgroundMessages: background }),
          ...(window === undefined ? {} : { resumedWindow: window }),
          ...(carried.length === 0 ? {} : { resumedTranscript: carried }),
          ...(options.model === undefined ? {} : { model: options.model }),
          onEnvelope: (envelope) => {
            options.onExecutionEnvelope?.(envelope);
            observe(envelope, observationRound);
            const activity = subagentToolActivity(envelope);
            if (activity !== undefined) context.reportTool?.(activity);
            options.onEnvelope?.({ ...envelope, attemptId: context.lineage.rootAttemptId });
          },
        });

        rounds += 1;
        transcript = result.transcript;
        envelopes = [...envelopes, ...result.envelopes];
        usage = addUsage(usage, result.usage);
        window = result.promptView;
        await options.onCheckpoint?.(transcript, window, result.state.terminalReason === "completed" ? "round_ready" : "interrupted", rounds);
        // The governed provider charges each response across all rounds, so an
        // over-budget round cannot keep issuing requests until runTurn returns.
        requireCompletedChild(result);
        const rawOutput = extractLatestAssistantText(transcript);

        await options.onRoundReady?.({ status: "completed", output: options.formatOutput?.(rounds, rawOutput) ?? rawOutput,
          rounds, usage, transcript, envelopes, ...(window === undefined ? {} : { promptView: window }) });

        // No channel means the historical shape: run once, finish.
        if (context.input === undefined) {
          break;
        }

        context.setActivity?.("idle");
        const idleTimer = options.idleTimeoutMs === undefined ? undefined
          : (options.scheduler ?? systemTimerScheduler)(options.idleTimeoutMs, () => {
            options.onIdle?.();
            context.input?.close();
          });
        let next;

        try { next = await context.input.next(context.signal); }
        finally { idleTimer?.cancel(); }

        if (next === "closed") {
          break;
        }

        carried = transcript;
        prompt = next.message;
        receipt = next.receipt;
        handoff = next.handoff;
        dependencies = next.dependencies;
        context.reportProgress(
          `Round ${rounds} answered; taking the next instruction`,
          undefined,
        );
      }

      const rawOutput = extractLatestAssistantText(transcript);
      const output = options.formatOutput?.(rounds, rawOutput) ?? rawOutput;

      context.reportProgress(`Subagent finished after ${rounds} round(s)`, 100);

      return {
        status: "completed",
        output,
        rounds,
        usage,
        transcript,
        envelopes,
        parked: options.isParked?.() ?? false,
        ...(window === undefined ? {} : { promptView: window }),
      };
    } finally {
      options.approvalScope?.dispose();
      if (options.providerSession === undefined) session.close();
    }
  };
}

/** Kept for symmetry with `child-attempt.ts`'s default, and for the profile seam. */
export const INTERACTIVE_DEFAULT_PROFILE: ProfilePort = {
  async load() {
    return EMPTY_PROFILE;
  },
};
