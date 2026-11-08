import { providerContinuationScope, type ProviderRequest, type ProviderRequestPreparation } from "../ports/provider.js";
import { promptContextFor, type CompactionWiring } from "./compact-boundary.js";
import { budgetCeiling, callerBudgetSpent, fitRequestToContext } from "./budget-gate.js";
import type { IterationPurpose } from "./interruption-report.js";
import type { teachingFor } from "./method-signal.js";
import { buildRequest, continuationAppend } from "./request.js";
import type { Engine } from "./runner-engine.js";
import type { LoopPorts } from "./runner.js";
import { nextId } from "./journal-emit.js";
import { dispatch } from "./runner-effects.js";
import { preparedCompaction } from "./prepared-compaction.js";
import { emitCompactionFor } from "./host-views.js";
import { localPreparedRequestTokens, measureNativeRequestIdentity, type PromptBudgetBasisDecision, type PromptMeasurement } from "./prompt-measurement.js";

type IterationRequestInput = {
  readonly engine: Engine;
  readonly ports: LoopPorts;
  readonly purpose: IterationPurpose;
  readonly teaching: Awaited<ReturnType<typeof teachingFor>>;
};

class RequestApplicationFailure extends Error {}

/** A rejected stream may rebase this request, but must not readmit its host
 * context or ask for another teaching slot while recovering the same purpose. */
export type PreparedIterationRequest = {
  readonly request: ProviderRequest;
  readonly teaching: IterationRequestInput["teaching"];
  readonly rebuild: () => ProviderRequest;
  readonly compaction?: CompactionWiring;
  readonly budgetDecision?: PromptBudgetBasisDecision;
  readonly requestMeasurement?: PromptMeasurement;
};

export type RequestRecovery =
  | { readonly kind: "retry"; readonly prepared: PreparedIterationRequest }
  | { readonly kind: "no_progress" }
  | { readonly kind: "stopped" };

/** Dynamic host state is read once. The exact same snapshot is priced, sent,
 * and reused if history must be compacted before this stream can start. */
export async function prepareIterationRequest(input: IterationRequestInput): Promise<PreparedIterationRequest | undefined> {
  const base = requestFor(input);
  let snapshot: ProviderRequestPreparation | undefined;

  try {
    snapshot = await input.ports.provider.prepareRequest?.(base, input.engine.abort.signal);
  } catch {
    if (!input.engine.abort.signal.aborted) await dispatch(input.engine, input.ports, {
      type: "transport_fail", eventId: nextId(input.engine), message: "request_preparation_failed", errorClass: "protocol",
    });
    // Cancellation is finalized by runIterations; a real preparation failure
    // has a typed terminal above and cannot escape with a live unended turn.
    return undefined;
  }

  if (input.engine.abort.signal.aborted) return undefined;

  const prepared = snapshot === undefined ? undefined : {
    apply: (request: ProviderRequest): ProviderRequest => {
      try { return snapshot.apply(request); }
      catch { throw new RequestApplicationFailure(); }
    },
  };
  const apply = (request: ProviderRequest) => prepared?.apply(request) ?? request;
  const wiring = input.ports.compaction;

  return requestOperation(input.engine, input.ports, async () => {
    const bundle: PreparedIterationRequest = {
      request: apply(base), teaching: input.teaching, rebuild: () => apply(requestFor(input)),
      ...(prepared === undefined || wiring === undefined ? {} : { compaction: preparedCompaction(wiring, prepared, base) }),
    };
    return fitPreparedRequest(input.engine, input.ports, bundle);
  });
}

/** Provider rejection recovery compares two complete presentations through
 * one frozen snapshot. A summary alone is not evidence of a smaller request. */
export async function recoverIterationRequest(engine: Engine, ports: LoopPorts,
  prepared: PreparedIterationRequest): Promise<RequestRecovery> {
  return await requestOperation(engine, ports, async (): Promise<RequestRecovery> => {
    if (await callerBudgetSpent(engine, ports, "requests")) return { kind: "stopped" };

    const before = localRequestTokens(ports, prepared.request);
    const rescuePorts = prepared.compaction === undefined ? ports : { ...ports, compaction: prepared.compaction };

    engine.reactiveCompactions += 1;
    const outcome = await emitCompactionFor(engine, rescuePorts, { force: true });

    if (engine.compactionSignal.aborted) return { kind: "stopped" };

    if (!outcome.storedWindow) return { kind: "no_progress" };

    const rebuilt = { ...prepared, request: prepared.rebuild() };
    if (localRequestTokens(ports, rebuilt.request) >= before) return { kind: "no_progress" };

    // A rejected send still consumed an explicit request allowance. Recheck
    // all caller budgets before recovery can send again; no retry refunds it.
    if (await budgetCeiling(engine, ports)) return { kind: "stopped" };

    if (engine.compactionSignal.aborted) return { kind: "stopped" };

    const fitted = await fitPreparedRequest(engine, ports, { ...rebuilt, request: prepared.rebuild() });
    if (fitted === undefined) return { kind: "stopped" };

    return localRequestTokens(ports, fitted.request) < before
      ? { kind: "retry", prepared: fitted } : { kind: "no_progress" };
  }) ?? { kind: "stopped" };
}

async function fitPreparedRequest(engine: Engine, ports: LoopPorts,
  prepared: PreparedIterationRequest): Promise<PreparedIterationRequest | undefined> {
  const fitted = await fitRequestToContext(engine, ports, prepared.request, prepared);
  return fitted === undefined ? undefined : { ...fitted, teaching: prepared.teaching, rebuild: prepared.rebuild,
    ...(prepared.compaction === undefined ? {} : { compaction: prepared.compaction }) };
}

function localRequestTokens(ports: LoopPorts, request: ProviderRequest): number {
  return ports.compaction === undefined ? 0 : localPreparedRequestTokens(request, ports.compaction, ports.tools,
    measureNativeRequestIdentity(ports.provider, request));
}

async function requestOperation<T>(engine: Engine, ports: LoopPorts, operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    // Only presentation failures are translated here. In particular an author
    // or storage exception during compaction retains its existing contract.
    if (!(error instanceof RequestApplicationFailure)) throw error;

    if (!engine.compactionSignal.aborted) await dispatch(engine, ports, {
      type: "transport_fail", eventId: nextId(engine), message: "request_preparation_failed", errorClass: "protocol",
    });

    return undefined;
  }
}

function requestFor({ engine, ports, purpose, teaching }: IterationRequestInput): ProviderRequest {
  const append = continuationAppend(engine.state.finishReason, engine.systemPromptAppend);
  return buildRequest({
    attemptId: engine.state.currentAttemptId,
    model: engine.model,
    continuationScope: providerContinuationScope(engine.state.sessionId, engine.state.turnId),
    ...(purpose === "final_report" ? { finalReport: "budget_limit" as const } : {}),
    ...(typeof purpose === "object" ? { finalReport: purpose } : {}),
    tools: ports.tools,
    prompt: promptContextFor(engine, ports.compaction, ports.tools),
    ...(engine.budget.maxOutputTokens === undefined ? {}
      : { maxOutputTokens: engine.budget.maxOutputTokens - engine.usage.outputTokens }),
    ...(teaching.slot === undefined ? {} : { slot: teaching.slot.message }),
    ...(teaching.toolGapSlot === undefined ? {} : { toolGapSlot: teaching.toolGapSlot }),
    ...(engine.systemPrompt === undefined ? {} : { systemPrompt: engine.systemPrompt }),
    ...(append === undefined ? {} : { systemPromptAppend: append }),
    ...(engine.responseSchema === undefined ? {} : { responseSchema: engine.responseSchema }),
  });
}
