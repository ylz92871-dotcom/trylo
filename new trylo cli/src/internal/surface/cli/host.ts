import type { TurnHostInput } from "./host-input.js";
import { bootstrapContextFor } from "./bootstrap-context.js";

import { openMcpRuntime, type McpRuntime } from "../../adapters/mcp-runtime/index.js";
import { openProgressiveMcpRuntime } from "../../adapters/mcp-runtime/progressive.js";

import { runRecordedTurn, budgetOf, pricingOf } from "./turn-execution.js";
import { hostFailure } from "./host-failure.js";
import { createTurnRecorder } from "./turn-recorder.js";
import { createParentProviderReturnObserver } from "./provider-return-observer.js";


import { createToolGapRuntimeFor } from "./tool-learning-config.js";
import { createTurnLearning } from "./turn-learning.js";
import { rewardObserverFor } from "./reward-wiring.js";
import { combineEnvelopeObservers } from "./envelope-observers.js";
import { createTurnRenderer } from "./render.js";
import { localRulesFor } from "./project-rules.js";
import { memoryForTurnInput } from "./memory-wiring.js";
import { memoryCommandWiring } from "./memory-command-provider.js";
import { fileCommandWiring } from "./file-command-provider.js";
import { reportProjectNotices } from "./turn-project-notices.js";
import { createSubagentJournalSink, finishSubagentEvents } from "./subagent-sink.js";
import { createSubagentCheckpointJournal } from "../../adapters/subagent-checkpoints/journal.js";

import { wiringFailure, type TurnOutcome } from "./turn-finish.js";
import { createCheckLearningForTurn, finishCheckLearningTurn, closeCheckLearningTurn } from "./check-learning-wiring.js";
import { turnStartRefusal } from "./turn-start-checks.js";
import { wirePorts } from "./wiring.js";
import { turnWiringInput } from "./turn-wiring-input.js";
import { executeCompaction } from "./compact-maintenance.js";
import type { RunFailure } from "./run-failure.js";

import { toolReadStrategyFor } from "./tool-read-strategy.js";
import { isLegacyBootstrapText } from "./user-input-source.js";

import { finishTopicLearning } from "./topic-boundary.js";
import { resolveToolPrompt } from "./turn-tool-context.js";

// The finish owns TurnOutcome; keep its existing host import path compatible.
export type { TurnOutcome } from "./turn-finish.js";
export type { TurnHostInput, ProjectContext, ProjectInstructionSource, McpRuntimeContext } from "./host-input.js";

export type TurnFailure = RunFailure;

// Re-exported: these are pure, live in `host-status.ts` now, and the host is
// still the one public place consumers read them from.
export { exitCodeForResult, terminalStatusOf, usageToCli, isTurnFailure } from "./host-status.js";

/** Async MCP startup belongs to the turn, outside synchronous wirePorts.
 * Its finally closes the resources even when the turn fails.
 */
export async function executeTurn(input: TurnHostInput): Promise<TurnOutcome | TurnFailure> {
  const mcp = input.mcp === undefined ? undefined : input.mcp.progressive
    ? await openProgressiveMcpRuntime(input.mcp, input.mcp.progressive) : await openMcpRuntime(input.mcp);
  try {
    return await runTurnWithPorts(input, mcp);
  } catch (error) {
    return await hostFailure(error, input.session);
  } finally {
    await mcp?.close();
  }
}

/** The turn itself, with the MCP table already opened — or deliberately absent. */
async function runTurnWithPorts(
  input: TurnHostInput,
  mcp: McpRuntime | undefined,
): Promise<TurnOutcome | TurnFailure> {
  const { userLearning, topics, observe } = createTurnLearning(input);
  // The explicit-memory endpoint and the read source are built together: they
  // must agree about which facts exist, and the write half exists only when the
  // switch does. See `memory-wiring.ts` for why they cannot be built apart.
  const memory = memoryForTurnInput(input);
  const readRouting = toolReadStrategyFor(input, topics);
  const toolGap = input.toolGap === undefined ? undefined : createToolGapRuntimeFor(input.toolGap);

  if (input.userSourceAvailable !== false && !isLegacyBootstrapText(input.text)) toolGap?.captureTask?.(input.turnId, input.text);

  const providerObservation = createParentProviderReturnObserver(input);
  const recorder = createTurnRecorder({ ...input,
    ...(providerObservation.capture === undefined ? {} : { providerWaitObservation: providerObservation.capture }),
    readProviderReturnObservation: providerObservation.read,
  });
  const recordedInput = recorder === undefined ? input : { ...input, session: recorder.session };
  const subagentSink = createSubagentJournalSink(recordedInput);
  const checkpoints = recordedInput.session !== undefined && (input.subagentEnabled === true || input.providerId === "fixture-subagent")
    ? createSubagentCheckpointJournal(input.resumeRecords ?? [], input.sessionId, async payload => {
      subagentSink.onEvent("observation", payload, `att-checkpoint-${input.turnId}`);
      await subagentSink.flush();
    }) : undefined;
  const wiring = fileCommandWiring(memoryCommandWiring(wirePorts(
    turnWiringInput(
      input,
      mcp,
      userLearning,
      toolGap,
      subagentSink.onEvent,
      // Per turn, by construction: `wirePorts` runs once per turn, so this
      // lookup's freeze lasts exactly this turn and the next turn re-reads the
      // current rule files. Nothing wider than a turn is constructed here.
      localRulesFor(input.execution?.workspaceRoot ?? input.workspaceRoot, input.projectContext,
        problem => input.sink.stderr(`${problem}\n`), input.resumeRecords),
      // Memory shares this turn's learning switch and project rules. Without
      // either, no memory port is constructed (WP20.3 / R1).
      memory.read,
      memory.write,
      checkpoints,
      topics,
      readRouting,
    ),
  ), input), input);
  if ("code" in wiring) {
    return wiringFailure(wiring.detail);
  }

  const reward = await rewardObserverFor(input, wiring.toolCatalogHash);
  const checks = await createCheckLearningForTurn(input, wiring);

  try {
    const refusal = await turnStartRefusal(wiring.ports.tools, input.toolSelection, wiring.permissionLedger, input.permissionLedger);
    if (refusal !== undefined) {
      return refusal;
    }

    if (input.text.trim() === "/compact") return await executeCompaction(input, wiring);

    const promptAppend = await resolveToolPrompt(input, (checks?.ports ?? wiring.ports).tools);
    const executionInput = promptAppend === undefined ? input : { ...input, systemPromptAppend: promptAppend };

    const startedAt = input.now();
    const bootstrapContext = bootstrapContextFor(input);

    await recorder?.start({ startedAt, toolCatalogHash: wiring.toolCatalogHash,
      ...(input.bootstrap?.state !== "import_pending" || bootstrapContext === undefined ? {} : { bootstrapContext }),
      ...(input.userSourceAvailable === undefined ? {} : { userSourceAvailable: input.userSourceAvailable }),
      ...(wiring.ports.provider.continuation === undefined ? {} : { continuation: wiring.ports.provider.continuation }),
      ...(input.projectContext === undefined ? {} : { sources: input.projectContext.sources }),
    });
    const taskProvider = wiring.centralLearning === undefined ? undefined
      : await wiring.centralLearning.beforeTask((checks?.ports ?? wiring.ports).provider, input.cancelSignal ?? new AbortController().signal);
    const budget = budgetOf(input);

    // The renderer is opened before the turn, not after it. Every envelope the
    // turn emits is translated and rendered as it happens, so the person watching
    // reads the answer while it is being written rather than once it is over
    // (WP D1/D2). It is the same translator the end-of-run projection uses, so a
    // scripted consumer sees the same sequence — only earlier.
    reportProjectNotices(input);

    const renderer = createTurnRenderer(input.format, input.sink, {
      ...(input.contextTokenLimit === undefined ? {} : { contextWindow: input.contextTokenLimit }),
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerId: wiring.providerId,
      model: wiring.model,
    });

    subagentSink.setRenderer({ onEnvelope: combineEnvelopeObservers(renderer.onEnvelope, wiring.collaboration?.capture) });

    if (wiring.subagentRuntime !== undefined) input.bindAgentTools?.(wiring.ports.tools);

    const result = await runRecordedTurn(
      { ...checks?.ports ?? wiring.ports,
        ...(recorder === undefined ? {} : { progress: recorder.progress }),
        provider: providerObservation.wrap(taskProvider ?? (checks?.ports ?? wiring.ports).provider) },
      executionInput, budget,
      pricingOf(input),
      combineEnvelopeObservers(renderer.onEnvelope, observe, reward?.capture, checks?.capture, input.onRunEnvelope, wiring.collaboration?.capture),
    );

    await finishSubagentEvents(wiring.subagentRuntime, subagentSink);
    const topicWarnings = await finishTopicLearning(input, topics);
    const finished = await finishCheckLearningTurn({
      result,
      renderer,
      input: { ...recordedInput, toolCatalogHash: wiring.toolCatalogHash },
      ...(recorder === undefined ? {} : { recorder }),
      startedAt,
      providerId: wiring.providerId,
      model: wiring.model,
      extraWarnings: [...mcp?.warnings ?? [], ...topicWarnings],
    }, checks);

    try { await wiring.centralLearning?.afterTask(input.cancelSignal ?? new AbortController().signal); }
    catch {
      // The normal task is already durably terminal. A failed learning source
      // nomination cannot change that outcome or imply any learner succeeded.
      input.sink.stderr("warning: central_learning_boundary_unavailable; original task result is retained\n");
    }

    return finished;
  } finally {
    await closeCheckLearningTurn({ reward, input, wiring, toolGap, checks });
  }
}
