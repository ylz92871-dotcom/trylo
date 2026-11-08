import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { CollaborationFailure } from "./contracts.js";
import type { CollaborationAnalysisFactV2, CollaborationAnalysisWindowV2, CollaborationAudience, CollaborationCycleV2,
  CollaborationGrantV2, CollaborationSelectionV2, CollaborationSubsystemOptionsV2, CollaborationV2Context, CollaborationV2Fact } from "./v2-contracts.js";
import { isCollaborationAnalysisResultV2, isCollaborationGrantV2, isCollaborationPracticeV2, isCollaborationV2Context, isCollaborationV2Fact } from "./v2-parse.js";
import { liveCollaborationVersionsV2, selectCollaborationActionsV2 } from "./v2-policy.js";
import { analysisWindowV2 } from "./v2-window.js";
import { admitCollaborationV2 } from "./v2-admit.js";
import { hydrateCollaborationArchiveV2 } from "./v2-hydration.js";
import { v2ConditionMatches } from "./v2-policy.js";
import { settleReservedUsageV2 } from "./v2-ledger-policy.js";

export type CollaborationInvocationV2 = { readonly subsystem: "collaboration"; readonly requestId: string; readonly scope: string;
  readonly grant: CollaborationGrantV2; readonly signal?: AbortSignal };

export type CollaborationRunResultV2 = { readonly ok: true; readonly cycleId?: string; readonly phase: CollaborationCycleV2["phase"] | "idle";
  readonly newVersionIds: readonly string[]; readonly spent: CollaborationCycleV2["spent"]; readonly cursor: number; readonly reason?: string }
  | (CollaborationFailure & { readonly cycleId?: string; readonly spent?: CollaborationCycleV2["spent"] });

type Options = CollaborationSubsystemOptionsV2;

type RuntimeOptions = Options & { readonly ownerId: string; readonly claimLeaseMs: number };

const enabled = (o: Options): boolean => o.enabled?.() !== false;
const emptyRun = (): CollaborationRunResultV2 => ({ ok: true, phase: "idle", newVersionIds: [], spent: { steps: 0, modelCalls: 0, modelTokens: 0 }, cursor: 0 });
const bad = (reason: string): CollaborationFailure => ({ ok: false, reason });
const scopeValid = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 512 && !["global", "*", "broad"].includes(s.toLowerCase().trim());

export function createCollaborationSubsystemV2(options: Options) {
  const ownerId = options.ownerId ?? "";
  const runtimeOptions = { ...options, ownerId, claimLeaseMs: options.claimLeaseMs ?? 180000 };
  const active = new Set<string>();
  const invoke = async (request: CollaborationInvocationV2): Promise<CollaborationRunResultV2> => {
    const key = contentHashOf([request?.scope, request?.requestId]);
    if (active.has(key)) return bad("cycle_in_progress");
    active.add(key);
    try { return await invokeV2(runtimeOptions, request); } finally { active.delete(key); }
  };
  const record = (fact: CollaborationV2Fact) => safely(async () => {
    if (!enabled(options)) return bad("collect_disabled");

    if (!isCollaborationV2Fact(fact) || fact.kind === "cycle" || fact.kind === "analysis") return bad("invalid_collaboration_fact");

    const dependencies = fact.kind === "adoption" ? [fact.exposureId, ...fact.eventIds] : fact.kind === "outcome" ? [...fact.adoptionIds, ...fact.episodeIds]
      : fact.kind === "episode" ? [...fact.eventIds, ...fact.evidenceRefs] : fact.kind === "event" ? fact.causedBy : [];
    if (dependencies.length > 0) {
      const hydrated = await hydrateCollaborationArchiveV2({ board: options.board, now: options.now,
        canContinue: () => enabled(options), query: { scope: fact.scope, factIds: dependencies } });
      if (!hydrated.ok) return hydrated;
    }

    if (!enabled(options)) return bad("collect_disabled");

    const result = await options.board.apply({ type: "record_collaboration_v2", commandId: `collaboration-v2:${fact.factId}`, issuedAt: fact.recordedAt, fact });

    return result.ok ? { ok: true as const } : bad(result.reason);
  });

  return {
    observe: (fact: Extract<CollaborationV2Fact, { kind: "event" | "episode" | "outcome" }>) =>
      ["event", "episode", "outcome"].includes(fact?.kind) ? record(fact) : Promise.resolve(bad("invalid_observation_kind")),
    recordReceipt: (fact: Extract<CollaborationV2Fact, { kind: "exposure" | "adoption" }>) =>
      ["exposure", "adoption"].includes(fact?.kind) ? record(fact) : Promise.resolve(bad("invalid_receipt_kind")),
    correct: (fact: Extract<CollaborationV2Fact, { kind: "correction" }>) =>
      fact?.kind === "correction" ? record(fact) : Promise.resolve(bad("invalid_correction_kind")),
    invoke: (request: CollaborationInvocationV2): Promise<CollaborationRunResultV2> => safely(() => invoke(request)),
    async prepareActions(context: CollaborationV2Context, audience: CollaborationAudience, maxPromptChars = 1200): Promise<CollaborationSelectionV2> {
      if (!enabled(options)) return { kind: "skip", reason: "collect_disabled" };

      if (!isCollaborationV2Context(context) || !["parent", "member"].includes(audience) || !Number.isSafeInteger(maxPromptChars)
        || maxPromptChars < 0 || maxPromptChars > 8000) return { kind: "skip", reason: "invalid_selection_input" };

      try {
        const loaded = await options.board.load();
        if (!loaded.ok) return { kind: "skip", reason: loaded.reason };

        if (!enabled(options)) return { kind: "skip", reason: "collect_disabled" };

        const selected = selectCollaborationActionsV2(loaded.state, context, audience, maxPromptChars);
        if (selected.kind === "selected" || !loaded.state.collaborationV2Archives?.some(a => a.scope === context.scope)) return selected;

        const candidates = liveCollaborationVersionsV2(loaded.state, context.scope).filter(a => isCollaborationPracticeV2(a.content)
          && v2ConditionMatches(a.content, context) && a.content.actions.some(action => action.audience === audience));
        const versions = candidates.slice(-8).map(a => a.versionId);
        const hydrated = await hydrateCollaborationArchiveV2({ board: options.board, now: options.now,
          canContinue: () => enabled(options), query: { scope: context.scope, versionIds: versions } });

        if (!enabled(options)) return { kind: "skip", reason: "collect_disabled" };

        if (!hydrated.ok) return { kind: "skip", reason: hydrated.reason };

        const restored = selectCollaborationActionsV2(hydrated.state, context, audience, maxPromptChars);

        return restored.kind === "skip" && candidates.length > versions.length ? { kind: "skip", reason: "source_lookup_limit" } : restored;
      } catch { return { kind: "skip", reason: "board_unavailable" }; }
    },
    inspect: (scope: string) => safely(async () => {
      if (!enabled(options)) return bad("collect_disabled");

      if (!scopeValid(scope)) return bad("invalid_scope");

      const loaded = await options.board.load();
      if (!loaded.ok) return bad(loaded.reason);

      if (!enabled(options)) return bad("collect_disabled");

      const heads = new Map<string, CollaborationCycleV2>();

      for (const f of loaded.state.collaborationV2Facts ?? []) if (f.kind === "cycle" && f.scope === scope) heads.set(f.cycleId, f);

      return { ok: true as const, cycles: [...heads.values()], boardSequence: loaded.state.sequence,
        archives: (loaded.state.collaborationV2Archives ?? []).filter(a => a.scope === scope),
        practiceVersions: loaded.state.assets.filter(a => a.scope === scope && isCollaborationPracticeV2(a.content)).map(a => a.versionId) };
    }),
    resumePending: (input: { readonly scope: string; readonly signal?: AbortSignal; readonly excludeRequestIds?: readonly string[] }): Promise<CollaborationRunResultV2> => safely(async () => {
      if (!enabled(options)) return bad("collect_disabled");

      if (!scopeValid(input.scope)) return bad("invalid_scope");

      if (input.excludeRequestIds !== undefined && (!Array.isArray(input.excludeRequestIds) || input.excludeRequestIds.length > 16
        || input.excludeRequestIds.some(id => typeof id !== "string" || !id || id.length > 200))) return bad("invalid_recovery_filter");

      const loaded = await options.board.load();
      if (!loaded.ok) return bad(loaded.reason);

      if (!enabled(options)) return bad("collect_disabled");

      let state = loaded.state;
      if (state.collaborationV2Archives?.some(a => a.scope === input.scope)) {
        const historical = await hydrateCollaborationArchiveV2({ board: options.board, now: options.now,
          canContinue: () => enabled(options) && !input.signal?.aborted,
          query: { scope: input.scope, pending: true, ...(input.excludeRequestIds === undefined ? {} : { excludeRequestIds: input.excludeRequestIds }) } });
        if (!historical.ok) return historical;
        state = historical.state;
      }

      const heads = new Map<string, CollaborationCycleV2>();

      for (const f of state.collaborationV2Facts ?? []) if (f.kind === "cycle" && f.scope === input.scope) heads.set(f.cycleId, f);

      const candidates = [...heads.values()].filter(f => !input.excludeRequestIds?.includes(f.requestId));
      const pending = candidates.find(f => f.phase === "running" || f.phase === "reserved")
        ?? candidates.find(f => f.phase === "waiting_evidence");

      return pending === undefined ? emptyRun() : invoke({ subsystem: "collaboration", scope: input.scope,
        requestId: pending.requestId, grant: pending.grant, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    }),
  };
}

async function invokeV2(options: RuntimeOptions, request: CollaborationInvocationV2): Promise<CollaborationRunResultV2> {
  if (!enabled(options)) return bad("collect_disabled");

  if (request === null || typeof request !== "object" || request.subsystem !== "collaboration" || !scopeValid(request.scope)
    || typeof request.requestId !== "string" || !request.requestId.trim() || request.requestId.length > 200 || !isCollaborationGrantV2(request.grant)) return bad("invalid_collaboration_budget");

  if (request.signal?.aborted) return bad("learning_aborted");

  if (request.grant.maxSteps === 0 || request.grant.maxModelCalls === 0 || request.grant.maxModelTokens === 0) return emptyRun();

  if (!options.ownerId) return bad("claim_owner_required");

  const loaded = await options.board.load();
  if (!loaded.ok) return bad(loaded.reason);

  if (!enabled(options)) return bad("collect_disabled");

  if (request.signal?.aborted) return bad("learning_aborted");

  let state = loaded.state;
  const cycleId = `collaboration-cycle:${contentHashOf([request.scope, request.requestId])}`;

  if (state.collaborationV2Archives?.some(a => a.scope === request.scope)) {
    const historical = await hydrateCollaborationArchiveV2({ board: options.board, now: options.now,
      canContinue: () => enabled(options) && !request.signal?.aborted, query: { scope: request.scope, cycleId } });
    if (!historical.ok) return historical;
    state = historical.state;
  }

  let current = (state.collaborationV2Facts ?? []).filter((f): f is CollaborationCycleV2 => f.kind === "cycle" && f.cycleId === cycleId).at(-1);
  if (current !== undefined && contentHashOf(current.grant) !== contentHashOf(request.grant)) return bad("cycle_grant_conflict");

  if (current?.phase === "failed") return { ok: false, reason: current.reason ?? "learning_failed", cycleId, spent: current.spent };

  if (current !== undefined && ["completed", "cancelled"].includes(current.phase)) return finished(current, []);

  if (current?.phase === "waiting_evidence") {
    if (state.collaborationV2Archives?.some(a => a.scope === request.scope)) {
      const historical = await hydrateCollaborationArchiveV2({ board: options.board, now: options.now,
        canContinue: () => enabled(options) && !request.signal?.aborted, query: { scope: request.scope, afterSequence: current.cursor } });
      if (!historical.ok) return historical;
      state = historical.state;
    }

    if (analysisWindowV2(state, request.scope, current.cursor) === undefined) return finished(current, []);

    const awakened = await appendCycle(options, current, { ...current, phase: "running", reason: "new_evidence" });
    if (!awakened.ok) return awakened;
    state = awakened.state;
    current = awakened.cycle;
  }

  if (current === undefined) {
    const cursor = Math.max(state.collaborationV2Archives?.find(a => a.scope === request.scope)?.learningCursor ?? 0,
      ...(state.collaborationV2Facts ?? []).filter((f): f is CollaborationCycleV2 => f.kind === "cycle" && f.scope === request.scope).map(f => f.cursor));
    const started = await appendCycle(options, undefined, { schemaVersion: 2, kind: "cycle", scope: request.scope, cycleId,
      requestId: request.requestId, phase: "running", step: 0, grant: request.grant, spent: { steps: 0, modelCalls: 0, modelTokens: 0 },
      cursor, sourceWindowHash: "none" });
    if (!started.ok) return started;
    state = started.state;
    current = started.cycle;
  }

  const versions: string[] = [];

  for (;;) {
    if (!enabled(options) || request.signal?.aborted) return endCycle(options, current, "cancelled", "learning_aborted", versions);

    if (current.phase !== "reserved") {
      if (current.spent.steps >= current.grant.maxSteps || current.spent.modelCalls >= current.grant.maxModelCalls
        || current.spent.modelTokens >= current.grant.maxModelTokens) return endCycle(options, current,
          current.reason?.startsWith("analysis_failed:") ? "failed" : "completed", current.reason?.startsWith("analysis_failed:")
            ? current.reason.slice("analysis_failed:".length) : "grant_exhausted", versions);

      if (state.collaborationV2Archives?.some(a => a.scope === request.scope)) {
        const historical = await hydrateCollaborationArchiveV2({ board: options.board, now: options.now,
          canContinue: () => enabled(options) && !request.signal?.aborted, query: { scope: request.scope, afterSequence: current.cursor } });
        if (!historical.ok) return historical;
        state = historical.state;
      }

      const ready = pickWithinAllowance(options, state, request.scope, current.cursor, current.grant.maxModelTokens - current.spent.modelTokens);
      if (ready === undefined) return endCycle(options, current, "waiting_evidence", "no_new_evidence", versions);

      if ("needTokens" in ready) return endCycle(options, current, "waiting_evidence", "input_budget_insufficient", versions);

      const { picked, maxTokens } = ready;
      const { usage: _previousUsage, reason: _previousReason, ...reservationBase } = current;
      const reserved = await appendCycle(options, current, { ...reservationBase, phase: "reserved", step: current.step + 1,
        spent: { steps: current.spent.steps + 1, modelCalls: current.spent.modelCalls + 1, modelTokens: current.spent.modelTokens + maxTokens },
        sourceWindowHash: contentHashOf(picked.window), claimOwner: options.ownerId,
        pinnedFactIds: [...picked.window.events, ...picked.window.episodes, ...picked.window.outcomes,
          ...(picked.window.receipts?.exposures ?? []), ...(picked.window.receipts?.adoptions ?? [])].map(f => f.factId),
        claimExpiresAt: new Date(Date.parse(options.now()) + (options.claimLeaseMs ?? 180000)).toISOString() });
      if (!reserved.ok) return reserved;

      if (reserved.replayed) return { ok: false, reason: "cycle_claim_active", cycleId, spent: reserved.cycle.spent };

      state = reserved.state;
      current = reserved.cycle;
      let response: Awaited<ReturnType<Options["analyzer"]["analyze"]>>;

      try { response = await options.analyzer.analyze({ cycleId, step: current.step, window: picked.window, maxTokens,
        signal: request.signal ?? new AbortController().signal }); }
      catch { response = { status: "failed", reason: "analysis_unavailable", tokenCost: maxTokens }; }

      if (!isCollaborationAnalysisResultV2(response)) response = { status: "failed", reason: "analysis_result_invalid", tokenCost: maxTokens };

      if (!enabled(options) || request.signal?.aborted) {
        const settlement = settleReservedUsageV2(current, maxTokens, response.usage);
        return endCycle(options, { ...current, ...settlement.accounting }, settlement.overrun ? "failed" : "cancelled",
          settlement.overrun ? "model_token_overrun" : "learning_aborted", versions);
      }

      const analysis: CollaborationAnalysisFactV2 = { schemaVersion: 2, kind: "analysis", factId: `analysis:${cycleId}:${current.step}`,
        scope: request.scope, recordedAt: options.now(), cycleId, step: current.step, sourceWindowHash: current.sourceWindowHash,
        throughCursor: picked.through, basis: { boardSequence: picked.window.boardSequence, eventIds: picked.window.events.map(e => e.factId),
          episodeIds: picked.window.episodes.map(e => e.factId), outcomeIds: picked.window.outcomes.map(e => e.factId),
          practiceVersionIds: picked.window.practices.map(p => p.versionId), exposureIds: picked.window.receipts?.exposures.map(e => e.factId) ?? [],
          adoptionIds: picked.window.receipts?.adoptions.map(e => e.factId) ?? [],
          ...(picked.window.projection === undefined ? {} : { projection: picked.window.projection }) }, result: response };
      const saved = await options.board.apply({ type: "record_collaboration_v2", commandId: `collaboration-v2:${analysis.factId}`, issuedAt: analysis.recordedAt, fact: analysis });
      if (!saved.ok) return { ok: false, reason: saved.reason, cycleId, spent: current.spent };
      state = saved.state;
    }

    const activeStep = current.step;
    const analysis = state.collaborationV2Facts?.find((f): f is CollaborationAnalysisFactV2 => f.kind === "analysis" && f.cycleId === cycleId && f.step === activeStep);
    if (analysis === undefined) {
      if (current.claimExpiresAt !== undefined && Date.parse(current.claimExpiresAt) > Date.parse(options.now())) {
        return { ok: false, reason: "cycle_claim_active", cycleId, spent: current.spent };
      }
      const recovered = await appendCycle(options, current, { ...current, phase: "running", reason: "recovered_unknown_outcome" });
      if (!recovered.ok) return recovered;
      state = recovered.state;
      current = recovered.cycle;
      continue;
    }

    const before = (state.collaborationV2Facts ?? []).filter((f): f is CollaborationCycleV2 => f.kind === "cycle" && f.cycleId === cycleId
      && f.phase === "running" && f.step === activeStep - 1).at(-1);
    if (before === undefined) return bad("cycle_reservation_missing");

    const response = analysis.result;
    const settlement = settleReservedUsageV2(current, current.spent.modelTokens - before.spent.modelTokens, response.usage);
    const settledSpent = settlement.accounting.spent;

    if (settlement.overrun) return endCycle(options,
      { ...current, ...settlement.accounting },
      "failed", "model_token_overrun", versions);

    if (response.status === "failed") {
      const retryable = await appendCycle(options, current, { ...current, phase: "running", spent: settledSpent,
        ...(response.usage === undefined ? {} : { usage: response.usage }), reason: `analysis_failed:${response.reason}` });
      if (!retryable.ok) return retryable;
      state = retryable.state;
      current = retryable.cycle;
      continue;
    }

    if (response.status === "proposed") {
      const window = windowFromBasis(state, analysis);
      if (contentHashOf(window) !== analysis.sourceWindowHash) return bad("analysis_window_recovery_mismatch");

      for (const draft of response.proposals) {
        if (!enabled(options) || request.signal?.aborted) return endCycle(options, { ...current, spent: settledSpent,
          ...(response.usage === undefined ? {} : { usage: response.usage }) }, "cancelled", "learning_aborted", versions);

        if (draft.actions.reduce((sum, action) => sum + action.instruction.length + 120, 300) > current.grant.maxPromptChars) return endCycle(options,
          { ...current, spent: settledSpent, ...(response.usage === undefined ? {} : { usage: response.usage }) }, "failed", "prompt_budget_exceeded", versions);

        const admitted = await admitCollaborationV2({ board: options.board, state, scope: request.scope, cycleId, window,
          windowHash: analysis.sourceWindowHash, draft, now: options.now, canContinue: () => enabled(options) && request.signal?.aborted !== true });
        if (!admitted.ok) {
          if (["board_unavailable", "lock_unavailable", "torn_write", "checksum_mismatch"].includes(admitted.reason)) return { ok: false, reason: admitted.reason, cycleId, spent: current.spent };
          const phase = admitted.reason === "learning_aborted" ? "cancelled" : "waiting_evidence";
          const rejected = await appendCycle(options, current, { ...current, phase, cursor: analysis.throughCursor, spent: settledSpent,
            ...(response.usage === undefined ? {} : { usage: response.usage }), reason: admitted.reason });
          return rejected.ok ? { ok: false, reason: admitted.reason, cycleId, spent: settledSpent } : rejected;
        }

        state = admitted.state;
        versions.push(admitted.versionId);
      }
    }

    const settled = await appendCycle(options, current, { ...current, phase: "running", cursor: analysis.throughCursor,
      spent: settledSpent, ...(response.usage === undefined ? {} : { usage: response.usage }), reason: response.status });
    if (!settled.ok) return settled;
    state = settled.state;
    current = settled.cycle;
  }
}

function windowFromBasis(state: BoardState, analysis: CollaborationAnalysisFactV2): CollaborationAnalysisWindowV2 {
  const facts = state.collaborationV2Facts ?? [], b = analysis.basis;
  return { schemaVersion: 2, scope: analysis.scope, boardSequence: b.boardSequence,
    ...(b.projection === undefined ? {} : { projection: b.projection }),
    events: facts.filter((f): f is Extract<CollaborationV2Fact, { kind: "event" }> => f.kind === "event" && b.eventIds.includes(f.factId)),
    episodes: facts.filter((f): f is Extract<CollaborationV2Fact, { kind: "episode" }> => f.kind === "episode" && b.episodeIds.includes(f.factId)),
    outcomes: facts.filter((f): f is Extract<CollaborationV2Fact, { kind: "outcome" }> => f.kind === "outcome" && b.outcomeIds.includes(f.factId)),
    receipts: {
      exposures: facts.filter((f): f is Extract<CollaborationV2Fact, { kind: "exposure" }> => f.kind === "exposure" && b.exposureIds.includes(f.factId)),
      adoptions: facts.filter((f): f is Extract<CollaborationV2Fact, { kind: "adoption" }> => f.kind === "adoption" && b.adoptionIds.includes(f.factId)),
    },
    practices: state.assets.flatMap(a => b.practiceVersionIds.includes(a.versionId) && isCollaborationPracticeV2(a.content) ? [{ versionId: a.versionId, practice: a.content }] : []) };
}

type CycleDraft = Omit<CollaborationCycleV2, "factId" | "recordedAt">;

async function appendCycle(options: Options, previous: CollaborationCycleV2 | undefined, draft: CycleDraft) {
  const { factId: _id, recordedAt: _at, ...clean } = draft as CollaborationCycleV2;
  const fact: CollaborationCycleV2 = { ...clean, factId: `cycle:${contentHashOf({ clean, previous: previous?.factId ?? null })}`, recordedAt: options.now() };
  const result = await options.board.apply({ type: "record_collaboration_v2", commandId: `collaboration-v2:${fact.factId}`,
    issuedAt: fact.recordedAt, fact, ...(previous === undefined ? {} : { expectedCycleFactId: previous.factId }) });
  return result.ok ? { ok: true as const, state: result.state, cycle: fact, replayed: result.idempotent } : { ok: false as const, reason: result.reason, cycleId: fact.cycleId, spent: fact.spent };
}

async function endCycle(options: Options, previous: CollaborationCycleV2, phase: "completed" | "cancelled" | "waiting_evidence" | "failed", reason: string, versions: readonly string[]): Promise<CollaborationRunResultV2> {
  const result = await appendCycle(options, previous, { ...previous, phase, reason });
  if (!result.ok) return result;
  return phase === "failed" ? { ok: false, reason, cycleId: previous.cycleId, spent: previous.spent } : finished(result.cycle, versions);
}

function finished(cycle: CollaborationCycleV2, versions: readonly string[]): CollaborationRunResultV2 {
  return { ok: true, cycleId: cycle.cycleId, phase: cycle.phase, newVersionIds: versions, spent: cycle.spent, cursor: cycle.cursor,
    ...(cycle.reason === undefined ? {} : { reason: cycle.reason }) };
}

function pickWithinAllowance(options: Options, state: BoardState, scope: string, cursor: number, remaining: number) {
  const estimate = options.analyzer.estimateInputTokens;
  let maxTokens = Math.min(8192, remaining);
  let picked = analysisWindowV2(state, scope, cursor, estimate === undefined ? undefined : { maxInputTokens: maxTokens - 1024, estimate });
  if (picked !== undefined && "needTokens" in picked && estimate !== undefined && picked.needTokens <= remaining) {
    maxTokens = remaining;
    picked = analysisWindowV2(state, scope, cursor, { maxInputTokens: maxTokens - 1024, estimate });
  }

  return picked === undefined || "needTokens" in picked ? picked : { picked, maxTokens };
}

async function safely<T extends { readonly ok: boolean }>(action: () => Promise<T>): Promise<T | CollaborationFailure> {
  try { return await action(); } catch { return bad("board_unavailable"); }
}
