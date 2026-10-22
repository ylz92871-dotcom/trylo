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
 *  - `outputBudgetSpent` runs *after* one iteration. Provider truncation
 *    (`finish_reason: length`) and a spent `--max-tokens` are the same failure
 *    here: one vocabulary, never a truncated answer dressed up as completion.
 *
 * Pure decision + dispatch, no stream, no tools: the loop stays the sequence
 * of phases, and the gate owns what the ceilings mean.
 */

/**
 * Whether a ceiling verdict may still be answered with a compaction.
 *
 * Two bounds, both per turn: the wiring has to exist, and a turn may attempt
 * at most `MAX_GAP_RESCUES_PER_TURN` rescues. A rescue that stored a window
 * and cleared the view lets the loop continue — and if a long task then grows
 * past the ceiling again, one more rescue is allowed. A rescue that cannot
 * clear the view ends the turn instead of trimming the same history twice.
 * Prior windows (a resumed session's, or one this turn already stored) do not
 * block a rescue: the ceiling is about the *next* request, and the post-window
 * re-judgement is what decides whether continuing is honest.
 */
const MAX_GAP_RESCUES_PER_TURN = 2;

/** Check the assembled request too: transient learning/report instructions are
 * added after the gap's history projection. They cannot bypass the hard cap.
 */
export async function fitRequestToContext(engine: Engine, ports: LoopPorts, request: ProviderRequest): Promise<ProviderRequest | undefined> {
  const wiring = ports.compaction, limit = engine.budget.contextTokenLimit;
  if (wiring === undefined || limit === undefined) return request;
  const tokens = wiring.estimatePromptTokens(request.messages) + (wiring.estimateOverheadTokens?.(ports.tools) ?? 0);
  if (tokens < limit) {
    // --max-tokens is a cumulative allowance, not space already available in
    // this request's context window. Never send an impossible reservation.
    // An absent output allowance remains absent: do not invent a thinking cap.
    return request.maxOutputTokens === undefined ? request
      : { ...request, maxOutputTokens: Math.min(request.maxOutputTokens, Math.floor(limit - tokens)) };
  }
  await dispatch(engine, ports, { type: "budget_exhausted", eventId: nextId(engine), reason: "context_limit", used: tokens, limit });
  return undefined;
}

function mayRescue(engine: Engine, ports: LoopPorts): boolean {
  return ports.compaction !== undefined && engine.gapCompactions < MAX_GAP_RESCUES_PER_TURN;
}

/** Whether this iteration's budget is spent; true means the loop must stop. */
export async function budgetCeiling(engine: Engine, ports: LoopPorts): Promise<boolean> {
  // A fresh/resumed turn has no server report yet. Measure before its first
  // send too; otherwise an oversized prompt bypasses the gate with zero usage.
  const basis = currentPromptBasis(promptContextFor(engine, ports.compaction, ports.tools));
  if (basis !== undefined) engine.promptTokens = basis;
  const contextLimit = engine.budget.contextTokenLimit;
  if (basis !== undefined && contextLimit !== undefined && basis >= autoCompactTokenLimit(contextLimit) && basis < contextLimit) {
    // Resumed history may already need compaction before any tools run.
    await emitCompactionFor(engine, ports);
  }
  const verdict = evaluateBudget(
    {
      iterations: engine.iterations,
      outputTokens: engine.usage.outputTokens,
      promptTokens: engine.promptTokens,
      costUsd: engine.costUsd,
    },
    engine.budget,
  );
  if (verdict.kind === "within_budget") {
    return false;
  }
  const gap = decideGap(verdict, mayRescue(engine, ports));
  if (gap.kind === "compact_then_continue") {
    engine.gapCompactions += 1;
    // Forced: the provider's own report proved the view over the ceiling, so
    // the threshold probe is not asked — and its per-turn latch must not
    // silence the one answer the ceiling still has.
    const outcome = await emitCompactionFor(engine, ports, { force: true });
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

/**
 * Output-budget stop after one iteration ran, checked before the iteration is
 * settled so a spent budget (or a provider truncation) pre-empts `complete`.
 *
 * Two facts, one verdict: `finishReason: length` means the provider cut the
 * stream at a token ceiling, and `evaluateBudget` saying `output_tokens_exhausted`
 * means our own accounting reached `--max-tokens`. Either ends the turn
 * `failed` with cause `output_tokens_exhausted` (exit 1, "raise --max-tokens,
 * or narrow the request") via the same `budget_exhausted` input the
 * pre-iteration ceiling uses — one failure vocabulary, not a second one.
 */
export async function outputBudgetSpent(engine: Engine, ports: LoopPorts): Promise<boolean> {
  const truncatedByProvider = engine.state.finishReason === "length";
  const verdict = evaluateBudget(
    {
      iterations: engine.iterations,
      outputTokens: engine.usage.outputTokens,
      promptTokens: engine.promptTokens,
      costUsd: engine.costUsd,
    },
    engine.budget,
  );
  if (!truncatedByProvider && verdict.kind !== "output_tokens_exhausted") {
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
