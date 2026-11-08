import type { BoardCommand } from "../../../../control/commands.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import { diagnoseEpisode, practiceFrom } from "./analysis.js";
import type { CollaborationBoardPort, CollaborationBudget, CollaborationContext, CollaborationDiagnosisFact,
  CollaborationEpisode, CollaborationFact, CollaborationFailure, CollaborationOutcome, CollaborationPractice, CollaborationSelection } from "./contracts.js";
import { isCollaborationContext, isCollaborationFact, isCollaborationPractice } from "./parse.js";
import { compileGuidance, selectPractice } from "./selection.js";

export type CollaborationLearningOptions = {
  readonly board: CollaborationBoardPort;
  readonly now: () => string;
  readonly collect?: boolean;
};

export type CollaborationInvocation = {
  readonly subsystem: "collaboration";
  readonly budget: CollaborationBudget;
  readonly signal?: AbortSignal;
};

export type CollaborationRun = { readonly ok: true; readonly examined: number; readonly createdVersionIds: readonly string[];
  readonly decisions: readonly { readonly subjectFactId: string; readonly diagnosis: CollaborationDiagnosisFact["diagnosis"] }[] } | CollaborationFailure;

/** Standalone subsystem: callers allocate work, never choose evidence, hypotheses or steps. */
export function createCollaborationLearning(options: CollaborationLearningOptions) {
  return {
    invoke: (request: CollaborationInvocation): Promise<CollaborationRun> => safely(() => invoke(options, request)),
    prepare: async (context: CollaborationContext, maxPromptChars = 1200): Promise<CollaborationSelection> => {
      if (options.collect === false) return { kind: "skip", reason: "collect_disabled" };

      if (!isCollaborationContext(context) || !validPromptBudget(maxPromptChars)) return { kind: "skip", reason: "invalid_selection_input" };

      try {
        const loaded = await options.board.load();
        return loaded.ok ? selectPractice(loaded.state, context, maxPromptChars) : { kind: "skip", reason: loaded.reason };
      } catch (error) {
        return { kind: "skip", reason: failureOf(error).reason };
      }
    },
    record: (fact: CollaborationFact): Promise<{ readonly ok: true } | CollaborationFailure> => safely(async () => {
      if (options.collect === false) return { ok: false, reason: "collect_disabled" };
      if (!isCollaborationFact(fact)) return { ok: false, reason: "invalid_collaboration_fact" };
      const result = await options.board.apply({ type: "record_collaboration_fact", commandId: `collaboration-fact:${fact.factId}`,
        issuedAt: fact.recordedAt, fact });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason, detail: result.detail };
    }),
  };
}

async function invoke(options: CollaborationLearningOptions, request: CollaborationInvocation): Promise<CollaborationRun> {
  if (options.collect === false) return { ok: false, reason: "collect_disabled" };

  if (request === null || typeof request !== "object" || request.subsystem !== "collaboration" || !validBudget(request.budget)) {
    return { ok: false, reason: "invalid_collaboration_budget" };
  }

  if (request.signal?.aborted) return { ok: false, reason: "learning_aborted" };

  if (request.budget.maxEpisodes === 0) return { ok: true, examined: 0, createdVersionIds: [], decisions: [] };

  const loaded = await options.board.load();
  if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail };

  let state = loaded.state;
  const facts = state.collaborationFacts ?? [];
  const processed = new Set(facts.filter(fact => fact.kind === "diagnosis").map(fact => fact.subjectFactId));
  const subjects = facts.filter((fact): fact is CollaborationEpisode | CollaborationOutcome =>
    (fact.kind === "episode" || fact.kind === "outcome") && !processed.has(fact.factId)).slice(0, request.budget.maxEpisodes);
  const decisions: { subjectFactId: string; diagnosis: CollaborationDiagnosisFact["diagnosis"] }[] = [];
  const createdVersionIds: string[] = [];

  for (const subject of subjects) {
    if (request.signal?.aborted) return { ok: false, reason: "learning_aborted" };

    const evaluated = evaluate(state, subject);
    let versionId: string | undefined;

    if (evaluated.practice !== undefined) {
      // Do not consume the subject on an unusably small grant; a later grant may retry it.
      if (compileGuidance(evaluated.practice.requiredFields).length > request.budget.maxPromptChars) {
        return { ok: false, reason: "prompt_budget_exceeded" };
      }

      const admitted = await admit(options, subject, evaluated.practice, evaluated.parentVersionId);
      if (!admitted.ok) return admitted;

      state = admitted.state;
      versionId = admitted.versionId;
      createdVersionIds.push(versionId);
    }

    const diagnosis: CollaborationDiagnosisFact = { schemaVersion: 1, kind: "diagnosis", factId: `diagnosis:${subject.factId}`,
      scope: subject.scope, recordedAt: options.now(), subjectFactId: subject.factId, diagnosis: evaluated.diagnosis,
      ...(versionId === undefined ? {} : { versionId }) };
    const applied = await options.board.apply({ type: "record_collaboration_fact", commandId: `collaboration-fact:${diagnosis.factId}`,
      issuedAt: diagnosis.recordedAt, fact: diagnosis });
    if (!applied.ok) return { ok: false, reason: applied.reason, detail: applied.detail };

    state = applied.state;
    decisions.push({ subjectFactId: subject.factId, diagnosis: evaluated.diagnosis });
  }

  return { ok: true, examined: decisions.length, createdVersionIds, decisions };
}

type Evaluation = { readonly diagnosis: CollaborationDiagnosisFact["diagnosis"]; readonly practice?: CollaborationPractice; readonly parentVersionId?: string };

function evaluate(state: BoardState, subject: CollaborationEpisode | CollaborationOutcome): Evaluation {
  if (subject.kind === "episode") {
    const diagnosis = diagnoseEpisode(subject);
    return diagnosis === "coordination" ? { diagnosis, practice: practiceFrom(subject) } : { diagnosis };
  }

  const fielding = state.collaborationFacts?.find(fact => fact.kind === "fielding" && fact.factId === subject.fieldingId);
  if (fielding?.kind !== "fielding") return { diagnosis: "unverified" };

  const diagnosis = diagnoseEpisode({ ...subject, kind: "episode", context: fielding.context, assignmentRef: fielding.requestId });
  const result = subject.result;
  if (result.source !== "member_report" && result.check === "passed" && result.capability === "sufficient"
    && result.reworkCount === 0 && result.missingFields.length === 0) return { diagnosis: "supports" };

  const asset = state.assets.find(item => item.versionId === fielding.versionId);
  if (diagnosis !== "coordination" || asset === undefined || !isCollaborationPractice(asset.content)) return { diagnosis };

  return { diagnosis, parentVersionId: asset.versionId, practice: { ...asset.content,
    requiredFields: [...new Set([...asset.content.requiredFields, ...result.missingFields])],
    sourceOutcomeIds: [...asset.content.sourceOutcomeIds, subject.factId].slice(-16) } };
}

async function admit(options: CollaborationLearningOptions, subject: CollaborationEpisode | CollaborationOutcome,
  practice: CollaborationPractice, parentVersionId?: string): Promise<{ readonly ok: true; readonly state: BoardState; readonly versionId: string } | CollaborationFailure> {
  const identity = contentHashOf({ scope: subject.scope, practice, parentVersionId: parentVersionId ?? null });
  const versionId = `collaboration-version:${identity}`;
  const proposalId = `collaboration-proposal:${identity}`;
  const issuedAt = options.now();
  const commands: BoardCommand[] = [
    { type: "submit_proposal", commandId: `${proposalId}:submit`, issuedAt, proposal: {
      proposalId, domain: "collaboration", scope: subject.scope, assetKind: "workflow", candidateRef: versionId,
      hypothesis: "Complete the missing artifact handoff context before dependent work; trial only, not a capability diagnosis.",
      observationRefs: [...practice.sourceEpisodeIds, ...practice.sourceOutcomeIds], risk: "low", requiredVerifiers: [],
      requestedAuthorities: [], source: "inferred", ...(parentVersionId === undefined ? {} : { baseVersionId: parentVersionId }) } },
    { type: "quarantine", commandId: `${proposalId}:quarantine`, issuedAt, proposalId },
    { type: "commit_asset", commandId: `${proposalId}:commit`, issuedAt, proposalId, versionId, content: practice, schemaVersion: 1,
      ...(parentVersionId === undefined ? {} : { parentVersionId }) },
    { type: "start_evaluation", commandId: `${proposalId}:evaluate`, issuedAt, proposalId },
  ];
  let state: BoardState | undefined;

  for (const command of commands) {
    const result = await options.board.apply(command);
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
    state = result.state;
  }

  return state === undefined ? { ok: false, reason: "board_unavailable" } : { ok: true, state, versionId };
}

function validPromptBudget(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 4000; }

function validBudget(value: CollaborationBudget): boolean {
  return value !== null && typeof value === "object" && Number.isSafeInteger(value.maxEpisodes)
    && value.maxEpisodes >= 0 && value.maxEpisodes <= 256 && validPromptBudget(value.maxPromptChars);
}

function failureOf(error: unknown): CollaborationFailure {
  return { ok: false, reason: "board_unavailable", detail: error instanceof Error ? error.message : String(error) };
}

async function safely<T extends { readonly ok: boolean }>(action: () => Promise<T>): Promise<T | CollaborationFailure> {
  try { return await action(); } catch (error) { return failureOf(error); }
}
