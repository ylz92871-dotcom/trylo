import { autoCompactTokenLimit } from "../compaction/policy.js";
import { evaluateBudget } from "../domain/iteration.js";
import { currentPromptBasis, promptContextFor } from "./compact-boundary.js";
import { decideGap } from "./iteration-gap.js";
import { emitCompactionFor } from "./host-views.js";
import { nextId } from "./journal-emit.js";
import type { Engine } from "./runner-engine.js";
import { dispatch } from "./runner-effects.js";
import type { LoopPorts } from "./runner.js";
import type { ProviderRequest } from "../ports/provider.js";
import type { CompactionWiring } from "./compact-boundary.js";
import { associatePromptBudgetDecision, evaluatePreparedRequestBudget, localPreparedRequestTokens, measureNativeRequestIdentity,
  type PromptBudgetBasisDecision, type PromptMeasurement } from "./prompt-measurement.js";
import { auxiliarySpendingUnavailable, spendingVerdict } from "./auxiliary-usage.js";
import { capturePersistableInputIdentity } from "./prompt-input-identity.js";
import { automaticRequestTokens } from "./automatic-pressure.js";

type RequestRebuild = {
  readonly rebuild: () => ProviderRequest;
  readonly compaction?: CompactionWiring;
};

export type FittedProviderRequest = {
  readonly request: ProviderRequest;
  readonly budgetDecision?: PromptBudgetBasisDecision;
  readonly requestMeasurement?: PromptMeasurement;
};

/**
 * The budget gate: where a turn's ceilings are enforced.
 *
 * Split out of `runner.ts` (WP09: the runner is a frozen-size wiring seam, and
 * the ceiling had grown a re-judgement and a rescue of its own). Two gates
 * live here, and their difference is the whole point:
 *
 *  - `budgetCeiling` runs *before* an iteration. A spent ceiling is answered
 *    by at most one compaction rescue — and only if the rescue actually clears
 *    the view, judged on the post-window basis rather than the stale report
 *    that tripped the gate.
 *  - `outputBudgetSpent` runs after one iteration and enforces only a
 *    caller-specified cumulative allowance. Provider response segmentation
 *    does not exhaust the task budget.
 *
 * Pure decision + dispatch, no stream, no tools: the loop stays the sequence
 * of phases, and the gate owns what the ceilings mean.
 */

/**
 * Whether a ceiling verdict may still be answered with a compaction.
 *
 * The wiring has to exist. A rescue that stored a window
 * and cleared the view lets the loop continue — and if a long task then grows
 * past the ceiling again, it may compact the new progress. A rescue that cannot
 * clear the view ends the turn instead of trimming the same history twice.
 * Prior windows (a resumed session's, or one this turn already stored) do not
 * block a rescue: the ceiling is about the *next* request, and the post-window
 * re-judgement is what decides whether continuing is honest.
 */

/** Check the assembled request too: transient learning/report instructions are
 * added after the gap's history projection. They cannot bypass the hard cap.
 */
export async function fitRequestToContext(engine: Engine, ports: LoopPorts, request: ProviderRequest,
  prepared?: RequestRebuild): Promise<FittedProviderRequest | undefined> {
  const wiring = ports.compaction, limit = engine.budget.contextTokenLimit;
  if (wiring === undefined || limit === undefined) return { request };

  const estimate = (request: ProviderRequest) => {
    const native = measureNativeRequestIdentity(ports.provider, request);
    const local = localPreparedRequestTokens(request, wiring, ports.tools, native);
    return evaluatePreparedRequestBudget(request, local, engine.promptReport,
      engine.compaction.window?.windowId, wiring.estimatePromptTokens,
      native, wiring.estimateTextPromptTokens,
      capturePersistableInputIdentity(ports.provider, request, engine.compaction.window));
  };
  let evaluation = estimate(request);
  let tokens = evaluation.decision.tokens;
  const pressure = (request: ProviderRequest, value: typeof evaluation) => automaticRequestTokens(request, wiring,
    engine.promptReport, engine.compaction.window?.windowId, value);
  let automaticTokens = pressure(request, evaluation);
  const trigger = autoCompactTokenLimit(limit);

  // Re-arm from the final request's basis, including a matching complete
  // provider measurement. An irreducible byte bound must not force a new
  // summary at every send and invalidate that measurement again.
  if (automaticTokens < trigger) engine.compaction.attempted = false;

  // A freshly prepared host slot can make otherwise valid history too large.
  // Automatic preparation obeys the same ineffective/refused latch as the
  // iteration gap. A real provider rejection retains its separate forced
  // recovery path; there is no turn-wide compaction count or task limit.
  while (automaticTokens >= trigger && prepared !== undefined && !engine.compaction.attempted && !engine.abort.signal.aborted) {
    const rescuePorts = prepared.compaction === undefined ? ports : { ...ports, compaction: prepared.compaction };
    const outcome = await emitCompactionFor(engine, rescuePorts, { estimatedPromptTokens: automaticTokens, phase: "preparing_request" });

    if (engine.compactionSignal.aborted) return undefined;

    if (await callerBudgetSpent(engine, ports)) return undefined;

    if (!outcome.storedWindow) break;

    request = prepared.rebuild();
    const nextEvaluation = estimate(request);
    const nextTokens = nextEvaluation.decision.tokens;
    const improved = nextTokens < tokens;

    evaluation = nextEvaluation;
    tokens = nextTokens;
    automaticTokens = pressure(request, nextEvaluation);
    engine.compaction.attempted = wiring.estimateAutomaticTokens !== undefined || automaticTokens >= trigger;

    if (!improved) break;
  }

  if (engine.abort.signal.aborted) return undefined;

  // A byte upper bound above the window is not evidence that the actual
  // tokenizer exceeds it. It may request useful compaction; only an unchanged
  // complete measurement (or the existing provider error path) can establish
  // this hard refusal. A measured prefix with new bounded text is still an
  // upper bound, not an exact complete count.
  const uncertainTextBound = usesTextUpperBound(wiring) && evaluation.exactInputTokens === undefined;

  if (tokens < limit || uncertainTextBound) {
    // --max-tokens is a cumulative allowance, not space already available in
    // this request's context window. Never send an impossible reservation.
    // An absent output allowance remains absent: do not invent a thinking cap.
    const fitted = request.maxOutputTokens === undefined || uncertainTextBound ? request
      : { ...request, maxOutputTokens: Math.min(request.maxOutputTokens, Math.floor(limit - tokens)) };
    // The output allowance is associated with the actual final request but is
    // not an input-token setting. Rebinding this pure hash cannot query native
    // state or run a different admission calculation for the observation.
    return { request: fitted, requestMeasurement: evaluation.measurement,
      budgetDecision: associatePromptBudgetDecision({ ...evaluation.decision,
        ...(wiring.estimateAutomaticTokens === undefined ? {} : { automaticTokens }),
      }, fitted, evaluation.measurement) };
  }

  await dispatch(engine, ports, { type: "budget_exhausted", eventId: nextId(engine), reason: "context_limit", used: tokens, limit });

  return undefined;
}

function mayRescue(ports: LoopPorts): boolean {
  return ports.compaction !== undefined;
}

function usesTextUpperBound(wiring: CompactionWiring | undefined): boolean {
  return wiring?.estimateAccuracy === "text_upper_bound";
}

/** Whether this iteration's budget is spent; true means the loop must stop. */
export async function budgetCeiling(engine: Engine, ports: LoopPorts): Promise<boolean> {
  if (engine.compactionSignal.aborted) return false;

  if (await callerBudgetSpent(engine, ports)) return true;

  // A fresh/resumed turn has no server report yet. Measure before its first
  // send too; otherwise an oversized prompt bypasses the gate with zero usage.
  // A presentation adapter may shrink the canonical MCP catalog, or add host
  // context. Its final request is authoritative; forecast cannot hard-stop it.
  const preparesRequest = usesTextUpperBound(ports.compaction)
    || ports.provider.prepareRequest !== undefined || ports.provider.continuation?.measureRequestIdentity !== undefined
    || ports.compaction !== undefined && ports.provider.inputBindingDigest !== undefined;
  const basis = preparesRequest ? undefined : currentPromptBasis(promptContextFor(engine, ports.compaction, ports.tools));
  if (basis !== undefined) engine.promptTokens = basis;

  const contextLimit = engine.budget.contextTokenLimit;
  if (basis !== undefined && contextLimit !== undefined && basis >= autoCompactTokenLimit(contextLimit) && basis < contextLimit) {
    // Resumed history may already need compaction before any tools run.
    await emitCompactionFor(engine, ports);
    if (engine.compactionSignal.aborted) return false;
    if (await callerBudgetSpent(engine, ports)) return true;
  }

  const verdict = evaluateBudget(
    {
      iterations: engine.iterations,
      outputTokens: engine.usage.outputTokens,
      promptTokens: preparesRequest ? 0 : engine.promptTokens,
      costUsd: engine.costUsd,
    },
    engine.budget,
  );
  if (verdict.kind === "within_budget") {
    return false;
  }

  const gap = decideGap(verdict, mayRescue(ports));
  if (gap.kind === "compact_then_continue") {
    engine.gapCompactions += 1;
    // Forced: the provider's own report proved the view over the ceiling, so
    // the threshold probe is not asked — and its per-turn latch must not
    // silence the one answer the ceiling still has.
    const outcome = await emitCompactionFor(engine, ports, { force: true });

    if (engine.compactionSignal.aborted) return false;

    if (await callerBudgetSpent(engine, ports)) return true;

    if (outcome.storedWindow && outcome.projectedPromptTokens !== undefined) {
      // The rescue stored its window; the stale server report of the request
      // that tripped the ceiling no longer describes what the next request
      // would carry. Re-judge on the post-window basis: only a view that is
      // genuinely under the ceiling lets the turn continue — a ceiling a
      // summary failed to clear is the hard gate, not another trim.
      const post = evaluateBudget(
        {
          iterations: engine.iterations,
          outputTokens: engine.usage.outputTokens,
          promptTokens: outcome.projectedPromptTokens,
          costUsd: engine.costUsd,
        },
        engine.budget,
      );
      if (post.kind === "within_budget") {
        return false;
      }

      await dispatch(engine, ports, {
        type: "budget_exhausted",
        eventId: nextId(engine),
        reason: post.kind,
        used: post.used,
        limit: post.limit,
      });

      return true;
    }
    // Nothing was stored — held below the local basis, a refused summary or a
    // degraded projection. The hard gate stands on the verdict that asked.
  }

  await dispatch(engine, ports, {
    type: "budget_exhausted",
    eventId: nextId(engine),
    reason: verdict.kind,
    used: verdict.used,
    limit: verdict.limit,
  });

  return true;
}

/** Spending is rechecked after auxiliary work without counting a main request
 * that preparation already reserved. Reactive recovery uses consumed requests. */
export async function callerBudgetSpent(engine: Engine, ports: LoopPorts,
  scope: "spending" | "requests" = "spending"): Promise<boolean> {
  // Cancellation owns its terminal transition at the runner boundary.
  if (engine.compactionSignal.aborted) return false;

  if (auxiliarySpendingUnavailable(engine.auxiliary, engine.budget)) {
    await dispatch(engine, ports, { type: "turn_failed", eventId: nextId(engine), reason: "auxiliary_usage_unavailable" });
    return true;
  }

  const usage = { iterations: engine.iterations, outputTokens: engine.usage.outputTokens, promptTokens: 0, costUsd: engine.costUsd };
  const verdict = scope === "requests" ? evaluateBudget(usage, engine.budget)
    : spendingVerdict(engine.usage, engine.costUsd, engine.budget);
  if (verdict.kind === "within_budget") return false;

  await dispatch(engine, ports, { type: "budget_exhausted", eventId: nextId(engine),
    reason: verdict.kind, used: verdict.used, limit: verdict.limit });

  return true;
}

/**
 * Output-budget stop after one iteration ran, checked before the iteration is
 * settled so a spent explicit allowance pre-empts `complete`.
 *
 * Only an explicit cumulative allowance can be exhausted here. A provider's
 * `length` finish preserves its output and asks for a follow-up request.
 */
export async function outputBudgetSpent(engine: Engine, ports: LoopPorts): Promise<boolean> {
  const verdict = evaluateBudget(
    {
      iterations: engine.iterations,
      outputTokens: engine.usage.outputTokens,
      promptTokens: engine.promptTokens,
      costUsd: engine.costUsd,
    },
    engine.budget,
  );
  if (verdict.kind !== "output_tokens_exhausted") {
    return false;
  }

  await dispatch(engine, ports, {
    type: "budget_exhausted",
    eventId: nextId(engine),
    reason: "output_tokens_exhausted",
    used: engine.usage.outputTokens,
    ...(engine.budget.maxOutputTokens === undefined ? {} : { limit: engine.budget.maxOutputTokens }),
  });

  return true;
}
