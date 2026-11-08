import { contentHashOf } from "../../../../control/hash.js";
import type { ToolEvolutionRequest, ToolEvolutionRequirement } from "../domain/evolution/contracts.js";
import { evolutionPrompt } from "../domain/evolution/prompt.js";
import { decodeToolParentSourceRead, readToolParentSourcePage, TOOL_PARENT_SOURCE_MAX_READS,
  TOOL_PARENT_SOURCE_PAGE_CHARS, type ToolParentSourcePage, type ToolParentSourceView } from "../domain/evolution/parent-source.js";
import { keysAre, recordOf, textOf } from "../domain/evolution/parse.js";
import { toolLearningInputTokenEstimate, TOOL_CONSTRUCTION_REQUEST_TOKENS } from "../domain/evolution/learning-resources.js";
import type { ToolEvolutionRuntimeOptions } from "./evolution-runtime.js";
import { invokeToolEvolutionPort, requestToolEvolutionText, type ToolEvolutionGeneratedText } from "./evolution-generation-transport.js";

export type ToolEvolutionGenerationAllowance = { readonly callsRemaining: number; readonly tokensRemaining: number; readonly maxPromptChars: number };

type Span = { readonly start: number; readonly end: number };

export type ToolEvolutionSourceState = { view: ToolParentSourceView | undefined; readonly observed: Span[]; reads: number };

/** Manual callers keep the old full-source, one-decision-per-attempt behavior. */
export function toolEvolutionSourceState(request: ToolEvolutionRequest, budgeted: boolean): ToolEvolutionSourceState {
  if (!budgeted || request.prior === undefined || request.prior.source.length <= TOOL_PARENT_SOURCE_PAGE_CHARS) return { view: undefined, observed: [], reads: 0 };
  const first = readToolParentSourcePage(request.prior, { action: "read_parent", baseContentHash: contentHashOf(request.prior.source), offset: 0 });
  return { observed: [], reads: 0, view: first.ok ? { pages: [first.page], boundary: { kind: "open" } } : undefined };
}

/** Investigate only immutable parent text. Every decision uses the original
 * provider/funding guard, and no verifier or archive runs until a candidate exists. */
export async function generateToolEvolutionCandidate(options: ToolEvolutionRuntimeOptions, request: ToolEvolutionRequest, attempt: number,
  state: ToolEvolutionSourceState, signal: AbortSignal, failure?: string): Promise<ToolEvolutionGeneratedText> {
  const identity = `tool-evolution-${contentHashOf(request).slice(0, 20)}-${options.now()}-${attempt}`;

  for (let decision = 0; decision <= TOOL_PARENT_SOURCE_MAX_READS; decision++) {
    if (signal.aborted) return { kind: "cancelled" };

    let allowance: ToolEvolutionGenerationAllowance | undefined;

    if (options.generationAllowance !== undefined) {
      const available = await invokeToolEvolutionPort(options.generationAllowance);
      if (!available.ok) return failed("learning_allowance_unavailable", "The original generation grant could not be inspected");
      allowance = available.value;
      if (allowance === undefined) return failed("learning_allowance_required", "The original generation grant is unavailable");
      if (allowance.callsRemaining < 1 || allowance.tokensRemaining < 128) return failed("learning_budget_exhausted", "The original generation grant has no candidate decision left");
      if (state.view?.boundary.kind === "open" && allowance.callsRemaining <= 1) state.view = { ...state.view, boundary: { kind: "candidate_only", reason: "reserved_call" } };
    }

    if (state.view?.boundary.kind === "open" && state.reads >= TOOL_PARENT_SOURCE_MAX_READS) state.view = { ...state.view, boundary: { kind: "candidate_only", reason: "read_limit" } };

    const fitted = fitGenerationPrompt(request, failure, state.view, allowance, options.requirements);
    if (fitted === undefined) return failed("generation_context_exceeds_allowance", "Mandatory public checks and bounded source evidence exceed this grant; no oracle was truncated");

    state.view = fitted.view;
    const generated = await requestToolEvolutionText(options, decision === 0 ? identity : `${identity}-source-${decision}`, fitted.prompt, signal);
    if (generated.kind !== "text" || state.view === undefined) return generated;

    for (const page of state.view.pages) state.observed.push({ start: page.offset, end: page.offset + page.text.length });

    let raw: unknown;

    try { raw = JSON.parse(generated.text); }
    catch { return generated; /* The canonical candidate parser reports malformed JSON. */ }

    if (!recordOf(raw)) return generated;

    if (raw.action === "defer") return generationDeferral(raw);

    if (raw.action !== "read_parent") return generated;

    if (state.view.boundary.kind === "candidate_only") return failed("parent_source_read_closed", "The last decision must return a candidate or defer; source research is closed");

    const read = decodeToolParentSourceRead(raw);
    if (read === undefined) return failed("invalid_parent_source_read", "Source reads require the exact host hash and bounded character coordinates");

    const result = readToolParentSourcePage(request.prior, read);
    if (!result.ok) return { kind: "failed", code: result.code, message: result.message };

    state.reads++;

    if (alreadyInspected(result.page, state.observed)) {
      state.view = { ...state.view, boundary: { kind: "candidate_only", reason: "no_new_source" } };
    } else {
      const first = state.view.pages[0];
      state.view = { ...state.view, pages: first === undefined || first.offset === result.page.offset ? [result.page] : [first, result.page] };
    }
  }

  return failed("parent_source_read_limit", "No final candidate after eight bounded parent-source reads");
}

function fitGenerationPrompt(request: ToolEvolutionRequest, failure: string | undefined, initial: ToolParentSourceView | undefined,
  allowance: ToolEvolutionGenerationAllowance | undefined, requirements: readonly ToolEvolutionRequirement[] | undefined) {
  let view = initial;

  for (let shrink = 0; shrink < 16; shrink++) {
    const prompt = evolutionPrompt(request, failure, view, requirements);
    if (allowance === undefined || (prompt.length <= Math.min(24_000, allowance.maxPromptChars) - 1024
      && toolLearningInputTokenEstimate([prompt], 768) + 128 <= Math.min(TOOL_CONSTRUCTION_REQUEST_TOKENS, allowance.tokensRemaining))) return { prompt, view };

    if (view === undefined) return undefined;

    const pages = [...view.pages], index = pages.findIndex(page => page.text.length > 256);
    const page = pages[index];
    if (page === undefined) return undefined;

    const size = Math.max(256, Math.floor(page.text.length / 2));

    pages[index] = { ...page, text: page.text.slice(0, size), nextOffset: page.offset + size };
    view = { ...view, pages };
  }

  return undefined;
}

function alreadyInspected(page: ToolParentSourcePage, spans: readonly Span[]): boolean {
  let covered = page.offset;
  for (const span of [...spans].sort((left, right) => left.start - right.start)) {
    if (span.start > covered) break;
    covered = Math.max(covered, span.end);
  }
  return covered >= page.offset + page.text.length;
}

function generationDeferral(raw: Record<string, unknown>): ToolEvolutionGeneratedText {
  return keysAre(raw, ["action", "reason", "neededEvidence"]) && textOf(raw.reason, 2048) && Array.isArray(raw.neededEvidence)
    && raw.neededEvidence.length <= 16 && raw.neededEvidence.every(ref => textOf(ref, 512))
    ? failed("parent_source_evidence_required", JSON.stringify({ reason: raw.reason, neededEvidence: raw.neededEvidence }))
    : failed("invalid_generation_deferral", "Deferral must identify bounded missing implementation evidence");
}

function failed(code: string, message: string): ToolEvolutionGeneratedText { return { kind: "failed", code, message }; }
