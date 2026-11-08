import { shortId } from "../../../../domains/shared/hash.js";
import { canonicalCardJson, type VariantRecord } from "../domain/contracts.js";
import { bounded, isContext, isDecision, MAX_METHOD_EXPERIENCE_FACTS, type MethodExperienceFact } from "../domain/experience-facts.js";
import { archived, effectivePredicate, hasScopeHistory, projectMaturity, scopeEnabled, scopesOf, type ExperienceSource } from "../domain/experience-state.js";
import { matchesScope } from "../domain/scope-learning.js";
import type { ExperienceContext, ExperienceDecision, ExperienceModelPort, ExperienceRuntimePort,
  ExperienceSelection, ExperienceConditionRequest } from "../experience-port.js";
import type { ExperienceSourceTrial } from "../experience-port.js";
import { METHOD_CONTEXT_TOOL } from "../experience-port.js";
import type { MethodBeatReport, MethodFeedbackNotice, MethodSlotDelivery } from "../port.js";
import { reviewExperiences } from "./experience-review.js";
import { canonicalObservations } from "../domain/inference-observations.js";
import { recordExecutionTrace } from "./experience-trace.js";
import { closeMissedAdoptionWindows } from "./adoption-window.js";
import { adoptionUnitKey, adoptionWindowClosed } from "../domain/adoption-window.js";
import { isMethodExecutionSpan, type MethodExecutionSpan } from "../domain/execution-trace.js";
import { expandExperience } from "./experience-expand.js";
import { sourceNeedsDeliberateTrial } from "../domain/source-trial-policy.js";
import { isMethodApplicationReport, sameNormalizedApplicationReport, type MethodApplicationReport } from "../domain/application-report.js";
import { contextCatalog, contextConditions, hookInstructions, selectedDelivery, selectExperiences, usableScopes } from "./experience-selection.js";
import { isCentralResearchMethodOrigin, methodOriginTaskId } from "../domain/research-origin.js";

export type ExperienceView = ExperienceSource & { readonly variants: readonly VariantRecord[] };

export type ExperienceStore = {
  load(): Promise<ExperienceView>;
  append(make: (current: ExperienceView) => MethodExperienceFact): Promise<ExperienceView>;
};

export type ExperienceRuntime = ExperienceRuntimePort & {
  observeBeat?(report: MethodBeatReport): Promise<void>;
  legacyArchive(): readonly VariantRecord[];
  legacyEligible?(versionId: string): boolean;
  allowLegacy(turnId: string): boolean;
  slot(turnId: string, toolNames?: readonly string[], retrievalCue?: string, retrievalSequence?: number,
    requestBoundarySequence?: number, previousExecutionSpan?: MethodExecutionSpan): Promise<MethodSlotDelivery | undefined>;
  enrich(notice: MethodFeedbackNotice): Promise<MethodFeedbackNotice>;
  endTurn(signal?: AbortSignal): Promise<void>;
  /** One normal or PA-selected review opportunity per host task. */
  claimReview?(): boolean;
};

export type ExperienceRuntimeOptions = {
  readonly centralSourceContext?: import("../experience-port.js").ExperienceReviewRequest["centralSourceContext"];
  readonly correct: (observationId: string, outcome: import("../domain/inference.js").MethodObservation["outcome"], reason: string,
    application?: MethodApplicationReport) => Promise<void>;
  readonly store: ExperienceStore;
  readonly model?: ExperienceModelPort;
  readonly revise: (versionId: string, hint: string) => Promise<void>;
  readonly emit: (kind: string, payload: Readonly<Record<string, string | number | boolean>>) => void;
};

/** Context selection is method-owned. Execution retains only the existing two narrow contacts. */
export function createExperienceRuntime(options: ExperienceRuntimeOptions): ExperienceRuntime {
  const state = new ExperienceRuntimeState(options);
  return {
    legacyArchive: () => state.legacyArchive(),
    legacyEligible: versionId => state.legacyEligible(versionId),
    allowLegacy: turnId => state.allowLegacy(turnId),
    context: (input, trial) => state.enter(input, trial),
    decide: input => state.decide(input),
    catalog: () => state.catalog(),
    observeBeat: report => state.observeBeat(report),
    takeContextConditions: () => state.takeContextConditions(),
    correct: input => state.correct(input),
    expand: versionId => state.expand(versionId),
    slot: (turnId, toolNames, retrievalCue, retrievalSequence, requestBoundarySequence, previousExecutionSpan) =>
      state.slot(turnId, toolNames, retrievalCue, retrievalSequence, requestBoundarySequence, previousExecutionSpan),
    enrich: notice => state.enrich(notice),
    endTurn: signal => state.endTurn(signal),
    claimReview: () => state.claimReview(),
  };
}

/** Task bindings are local; persistent facts and feedback remain owned by the injected Board store. */
class ExperienceRuntimeState {
  private contextState: { readonly kind: "unseen" } | { readonly kind: "refresh_needed"; readonly taskId: string } |
    { readonly kind: "bound"; readonly context: ExperienceContext; readonly trial?: ExperienceSourceTrial } = { kind: "unseen" };
  private readonly knownVersions = new Set<string>();
  private selected: readonly ExperienceSelection[] = [];
  private cachedKey = "";
  private readonly disabled = new Set<string>();
  private disabledTaskId: string | undefined;
  private reviewed = false;
  private planningTaskId: string | undefined;
  private available = true;
  private latestVariants: readonly VariantRecord[] = [];
  private readonly legacySuppressed = new Set<string>();
  private toolNames: readonly string[] | undefined;
  private pendingConditions: readonly ExperienceConditionRequest[] = [];
  private retrievalCue = "";
  private inputBoundary: { readonly taskId: string; readonly sequence: number } | undefined;
  private planningBoundary: number | undefined;
  private readonly locallyClosed = new Set<string>();
  private readonly unsafeAdoptionTasks = new Set<string>();

  constructor(private readonly options: ExperienceRuntimeOptions) {}

  private get context(): ExperienceContext | undefined {
    return this.contextState.kind === "bound" ? this.contextState.context : undefined;
  }

  allowLegacy(turnId: string): boolean {
    return this.available && !this.toolNames?.includes(METHOD_CONTEXT_TOOL) && this.context?.taskId !== turnId &&
      !(this.contextState.kind === "refresh_needed" && this.contextState.taskId === turnId);
  }

  legacyArchive(): readonly VariantRecord[] {
    return this.latestVariants;
  }

  legacyEligible(versionId: string): boolean {
    return !this.legacySuppressed.has(versionId);
  }

  takeContextConditions(): readonly ExperienceConditionRequest[] {
    // Conditions are delivered once at the next host boundary.
    const pending = this.pendingConditions;
    this.pendingConditions = [];

    return pending;
  }

  private async ensureScopes(): Promise<ExperienceView> {
    let current = await this.options.store.load();
    if (current.facts.length >= MAX_METHOD_EXPERIENCE_FACTS) throw new Error("method_experience_capacity");

    // Bounded legacy onboarding; no fabricated historical observations. New
    // scope registration starts prospective confirmation at the current sequence.
    // Research publication owns its explicit scope. A partial card write must
    // not acquire a guessed legacy scope while its publication is recovering.
    for (const variant of current.variants.filter(item => item.retention !== "evicted" && item.ledger.state !== "archived" &&
      !hasScopeHistory(current, item.versionId) && !archived(current, item.versionId)
      && !isCentralResearchMethodOrigin(item.card.lineage.createdFrom)).slice(-8)) {
      current = await this.options.store.append(state => state.facts.find(item => item.kind === "scope" && item.versionId === variant.versionId) ??
        ({ kind: "scope", factId: shortId("method-base", [variant.versionId]),
        versionId: variant.versionId, sequence: state.sequence + 1, description: variant.card.hint,
        hypothesis: { id: shortId("method-scope", [variant.versionId]), versionId: variant.versionId, scopeId: "base",
          predicate: { all: [{ feature: `use_${shortId("s", [variant.versionId])}`, value: "yes" }], exclude: [] },
          proposedSequence: state.sequence } }));
    }

    return current;
  }

  async catalog(): Promise<string> {
    const current = await this.ensureScopes();
    return contextCatalog(current, this.toolNames, this.retrievalCue, this.inputBoundary?.taskId);
  }

  async enter(input: ExperienceContext, trial?: ExperienceSourceTrial): Promise<readonly ExperienceSelection[]> {
    if (!isContext(input)) throw new Error("invalid_method_context");

    if (this.unsafeAdoptionTasks.has(input.taskId)) throw new Error("method_adoption_window_unavailable");

    if (trial !== undefined && (!bounded(trial.versionId, 200) || !bounded(trial.scopeId, 200))) throw new Error("invalid_method_trial");

    const current = await this.ensureScopes();

    if (this.disabledTaskId !== input.taskId) {
      this.disabled.clear();
      this.disabledTaskId = input.taskId;
    }

    for (const fact of current.facts) {
      if (fact.kind === "decision" && fact.context.taskId === input.taskId && fact.decision.action === "block") this.disabled.add(fact.versionId);
    }

    const key = canonicalCardJson([input, trial, this.toolNames, current.variants.map(item => [item.versionId, item.retention, item.ledger.state]),
      current.facts.filter(item => item.kind !== "decision"), [...this.disabled].sort()]);
    if (key === this.cachedKey) return this.selected;

    this.contextState = { kind: "bound", context: copyContext(input), ...(trial === undefined ? {} : { trial: { ...trial } }) };
    this.knownVersions.clear();
    for (const variant of current.variants) this.knownVersions.add(variant.versionId);

    this.selected = this.withClosedWindows(current, input.taskId, selectExperiences(current, input, this.disabled, this.toolNames, trial));
    this.pendingConditions = this.selected.length === 0 ? contextConditions(current, input, this.disabled, this.toolNames, trial) : [];
    this.cachedKey = key;
    this.options.emit("observation", { component: "method_context", taskId: input.taskId,
      opportunityId: input.opportunityId, selected: this.selected.length });

    return this.selected;
  }

  async decide(input: ExperienceDecision): Promise<void> {
    if (!isDecision(input) || this.context === undefined || !this.selected.some(item => item.versionId === input.versionId &&
      item.scopeId === input.scopeId)) throw new Error("method_decision_unbound");

    const selected = this.selected.find(item => item.versionId === input.versionId && item.scopeId === input.scopeId)!;
    const compilationId = selected.stable ? selected.compilationId : undefined;
    const unit = { versionId: input.versionId, taskId: this.context.taskId,
      ...(compilationId === undefined ? {} : { compilationId }) };

    if (input.action === "adopt") this.assertOpenAdoptionWindow(unit);

    if (input.compilationId !== undefined && input.compilationId !== compilationId) throw new Error("method_decision_stale_compilation");

    // Disable before IO or repair. A failed write must never create a local loop.
    if (input.action === "block") this.disable(input.versionId);

    const { step: requestedStep, ...decisionInput } = input;
    const knownStep = requestedStep === undefined || selected.procedureStepIds === undefined || selected.procedureStepIds.includes(requestedStep);
    if (!knownStep && input.action !== "block") throw new Error("method_decision_unknown_step");

    const decision: ExperienceDecision = { ...decisionInput, ...(compilationId === undefined ? {} : { compilationId }),
      ...(requestedStep === undefined || !knownStep ? {} : { step: requestedStep }) };
    const bound = copyContext(this.context);

    await this.options.store.append(state => {
      // Storage may have awaited a lock/read while a settled batch closed the
      // unit. Recheck at the synchronous construction boundary as well.
      if (input.action === "adopt") this.assertOpenAdoptionWindow(unit);
      return { kind: "decision", factId: shortId("method-decision", [bound.taskId,
        bound.opportunityId, input.versionId, input.scopeId, canonicalCardJson([bound.features, decision])]), versionId: input.versionId,
        sequence: state.sequence + 1, context: bound, decision };
    });

    if (!knownStep) this.options.emit("observation", { component: "method_step_attribution", versionId: input.versionId, reason: "unknown_step" });

    this.options.emit("observation", { component: "method_adoption", versionId: input.versionId,
      action: input.action, reason: input.reason });
  }

  async correct(input: Parameters<ExperienceRuntimePort["correct"]>[0]): Promise<void> {
    if (!bounded(input.observationId, 160) || !bounded(input.reason, 1000) ||
      !["helped", "unhelpful", "unknown", "external_failure"].includes(input.outcome) ||
      (input.application !== undefined && !isMethodApplicationReport(input.application))) throw new Error("invalid_method_correction");

    const current = await this.options.store.load();
    const prior = canonicalObservations(current.observations).find(item => item.observationId === input.observationId);
    if (prior === undefined || prior.source !== "self_report") throw new Error("method_correction_unattributable");

    if (prior.outcome === input.outcome && sameNormalizedApplicationReport(prior.application, input.application ?? prior.application)) return;

    this.disable(prior.versionId);
    await this.options.correct(input.observationId, input.outcome, input.reason, input.application);
    // A source correction replaces one trial; it does not erase the remaining
    // source evidence. Changed compilation proofs are withdrawn by maintenance.
    // A compiled correction still targets only that exact expression.
    const compilationId = prior.compilationId;
    if (input.outcome === "unhelpful" && prior.outcome !== "unhelpful" && compilationId !== undefined) {
      await this.options.store.append(state => ({ kind: "compilation_exit",
        factId: shortId("method-correction-compile-exit", [input.observationId, String(prior.revision + 1)]),
        versionId: prior.versionId, sequence: state.sequence + 1, scopeId: prior.scopeId, compilationId, reason: input.reason }));
    }
  }

  async expand(versionId: string): Promise<string> {
    const current = await this.options.store.load();
    const selected = this.selected.find(item => item.versionId === versionId && item.stable);
    const blocked = [...current.facts].reverse().find(item => item.kind === "decision" && item.versionId === versionId &&
      item.context.taskId === this.context?.taskId && item.decision.action === "block");
    return expandExperience(current, versionId, selected?.compilationId ??
      (blocked?.kind === "decision" ? blocked.decision.compilationId : undefined));
  }

  async slot(turnId: string, toolNames?: readonly string[], retrievalCue?: string, retrievalSequence?: number,
    requestBoundarySequence?: number, previousExecutionSpan?: MethodExecutionSpan): Promise<MethodSlotDelivery | undefined> {
    try {
      if (this.planningTaskId !== turnId) {
        this.planningTaskId = turnId;
        this.reviewed = false;
      }

      await this.preparePlanningBoundary(turnId, requestBoundarySequence, previousExecutionSpan);
      this.refreshInputBoundary(turnId, retrievalSequence);
      this.disabledTaskId ??= turnId;
      this.toolNames = toolNames;
      this.retrievalCue = (retrievalCue ?? "").slice(0, 1000);
      const current = await this.ensureScopes();

      this.latestVariants = current.variants;
      this.refreshLegacyEligibility(current);

      if (current.facts.length >= MAX_METHOD_EXPERIENCE_FACTS) throw new Error("method_experience_capacity");

      const maturity = projectMaturity(current);

      this.available = true;

      // Every planning boundary refreshes Board generation. Running bindings
      // survive ordinary feedback; new compilations take effect on enter().
      if (this.context?.taskId === turnId && current.variants.some(item => !this.knownVersions.has(item.versionId) &&
        methodOriginTaskId(item.card.lineage.createdFrom) === turnId && item.retention !== "evicted" && item.ledger.state !== "archived")) {
        this.requireContext(turnId, "new_task_method");
      }

      if (this.context?.taskId !== turnId) {
        const catalog = contextCatalog(current, this.toolNames, this.retrievalCue, turnId);
        return catalog.length === 0 ? undefined : { message: { role: "system", content: hookInstructions(catalog) }, receipts: [] };
      }

      const previousCount = this.selected.length;
      const eligibleScopes = usableScopes(current, toolNames);

      this.selected = this.selected.filter(item => !this.disabled.has(item.versionId) &&
        eligibleScopes.some(scope => scope.versionId === item.versionId && scope.hypothesis.scopeId === item.scopeId &&
          matchesScope(effectivePredicate(current, scope.hypothesis), this.context!.features) &&
          (item.stable || !sourceNeedsDeliberateTrial(current, scope.hypothesis) || this.explicitTrialFor(item))) &&
        (!item.stable || scopesOf(current, item.versionId).some(scope => scope.hypothesis.scopeId === item.scopeId &&
          maturity(scope.hypothesis)?.factId === item.compilationId)));

      if (this.selected.length < previousCount) {
        this.requireContext(turnId, "learning_asset_changed");
        const catalog = contextCatalog(current, this.toolNames, this.retrievalCue, turnId);
        return { message: { role: "system", content: hookInstructions(catalog) }, receipts: [] };
      }

      this.selected = this.withClosedWindows(current, turnId, this.selected);

      return selectedDelivery(current, this.selected, this.context!, this.planningBoundary);
    } catch (error) {
      // No stale binding may survive a failed read, scope registration or slot compilation.
      this.available = false;
      this.selected = [];
      this.pendingConditions = [];
      this.cachedKey = "";
      this.degraded("method_experience_slot", error);
      if (this.unsafeAdoptionTasks.has(turnId)) return { message: { role: "system", content:
        "[method context] 本任务的采用时点证据暂不可确认。正常分析，不补adopt或方法帮助反馈。" }, receipts: [] };
      return undefined;
    }
  }

  async enrich(notice: MethodFeedbackNotice): Promise<MethodFeedbackNotice> {
    // Exposure binding is immutable. Current planning context may already refer
    // to another opportunity when a prior request's feedback arrives.
    return notice;
  }

  async observeBeat(report: MethodBeatReport): Promise<void> {
    try {
      if (report.executionSpan !== undefined) {
        const alreadyUnsafe = this.unsafeAdoptionTasks.has(report.turnId);
        this.unsafeAdoptionTasks.add(report.turnId);
        await closeMissedAdoptionWindows(this.options, report.turnId, report.executionSpan, this.locallyClosed);
        if (!alreadyUnsafe) this.unsafeAdoptionTasks.delete(report.turnId);
      }
    } catch (error) { this.degraded("method_adoption_window", error); }

    const settled = this.context === undefined ? undefined : { context: copyContext(this.context),
      ...(this.planningBoundary === undefined ? {} : { requestBoundarySequence: this.planningBoundary }),
      selections: this.selected.map(item => ({ versionId: item.versionId, scopeId: item.scopeId,
        ...(item.stable ? { compilationId: item.compilationId } : {}) })) };

    try { await recordExecutionTrace(this.options, report, settled); }
    catch (error) { this.degraded("method_execution_trace", error); }
  }

  async endTurn(signal = new AbortController().signal): Promise<void> {
    if (signal.aborted || !this.claimReview()) return;
    try {
      const current = await this.options.store.load();
      if (!signal.aborted) await reviewExperiences(this.options, current, signal);
    } catch (error) { this.degraded("method_review", error); }
  }

  claimReview(): boolean {
    if (this.reviewed) return false;
    this.reviewed = true;
    return true;
  }

  private disable(versionId: string): void {
    this.disabled.add(versionId);
    this.selected = this.selected.filter(item => item.versionId !== versionId);
    this.cachedKey = "";
  }

  private assertOpenAdoptionWindow(unit: { readonly versionId: string; readonly taskId: string; readonly compilationId?: string }): void {
    if (this.unsafeAdoptionTasks.has(unit.taskId)) throw new Error("method_adoption_window_unavailable");
    if (this.locallyClosed.has(adoptionUnitKey(unit))) throw new Error("method_adoption_window_closed");
  }

  private async preparePlanningBoundary(taskId: string, boundary: number | undefined, previous: MethodExecutionSpan | undefined): Promise<void> {
    this.planningBoundary = undefined;

    if (boundary !== undefined && (!Number.isSafeInteger(boundary) || boundary < 0)) throw new Error("invalid_method_request_boundary");

    if (previous !== undefined && (!isMethodExecutionSpan(previous) || boundary === undefined ||
      previous.lastSequence > boundary || !previous.toolNames.some(name => name !== METHOD_CONTEXT_TOOL))) {
      throw new Error("invalid_method_previous_execution");
    }

    if (previous !== undefined) {
      this.unsafeAdoptionTasks.add(taskId);
      await closeMissedAdoptionWindows(this.options, taskId, previous, this.locallyClosed);
      this.unsafeAdoptionTasks.delete(taskId);
    } else if (this.unsafeAdoptionTasks.has(taskId)) throw new Error("method_adoption_window_unavailable");

    this.planningBoundary = boundary;
  }

  private withClosedWindows(source: ExperienceView, taskId: string, selections: readonly ExperienceSelection[]): readonly ExperienceSelection[] {
    return selections.map(item => {
      const unit = { versionId: item.versionId, taskId, ...(item.stable ? { compilationId: item.compilationId } : {}) };
      return this.locallyClosed.has(adoptionUnitKey(unit)) || adoptionWindowClosed(source.facts, unit) ?
        { ...item, adoptionWindowClosed: true } : item;
    });
  }

  private refreshLegacyEligibility(view: ExperienceView): void {
    this.legacySuppressed.clear();
    for (const variant of view.variants) {
      const scopes = scopesOf(view, variant.versionId);
      // Without semantic context, another valid range cannot establish that a
      // restricted/withdrawn range is safe for this task. Keep such versions in
      // the context path, where an unaffected range can still match normally.
      const rangeRestricted = view.facts.some(fact => fact.versionId === variant.versionId &&
        (fact.kind === "restriction" || fact.kind === "scope_retired" || fact.kind === "exit" && fact.mode === "scope"));
      if (archived(view, variant.versionId) || rangeRestricted ||
        isCentralResearchMethodOrigin(variant.card.lineage.createdFrom) && scopes.length === 0 ||
        scopes.some(scope => sourceNeedsDeliberateTrial(view, scope.hypothesis)) ||
        hasScopeHistory(view, variant.versionId) && !scopes.some(scope => scopeEnabled(view, scope.hypothesis))) {
        this.legacySuppressed.add(variant.versionId);
      }
    }
  }

  private refreshInputBoundary(turnId: string, sequence: number | undefined): void {
    if (sequence === undefined) return;
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid_method_cue_sequence");
    if (this.context?.taskId === turnId && this.inputBoundary?.taskId === turnId && this.inputBoundary.sequence !== sequence) {
      this.requireContext(turnId, "new_user_input");
    }
    this.inputBoundary = { taskId: turnId, sequence };
  }

  private explicitTrialFor(selection: ExperienceSelection): boolean {
    const trial = this.contextState.kind === "bound" ? this.contextState.trial : undefined;
    return trial?.versionId === selection.versionId && trial.scopeId === selection.scopeId;
  }

  private requireContext(taskId: string, reason: string): void {
    this.contextState = { kind: "refresh_needed", taskId };
    this.selected = [];
    this.pendingConditions = [];
    this.cachedKey = "";
    this.options.emit("observation", { component: "method_context_refresh", taskId, reason });
  }

  private degraded(component: string, error: unknown): void {
    try { this.options.emit("observation", { component, degraded: true,
      reason: error instanceof Error ? error.message : String(error) }); }
    catch { /* A broken diagnostic sink cannot turn learning degradation into task failure. */ }
  }
}

function copyContext(context: ExperienceContext): ExperienceContext {
  return { ...context, features: { ...context.features } };
}
