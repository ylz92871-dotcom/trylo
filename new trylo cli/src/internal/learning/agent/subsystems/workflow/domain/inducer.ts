import {
  submitDraftCommand,
  submitWithdrawCommand,
  type BoardCommandDraft,
} from "../../../../domains/shared/board-command.js";
import { ruleIdentity } from "../../../../domains/shared/dual-save.js";
import { scanForbiddenBody } from "../../../../domains/shared/forbidden-scan.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { workflowFamilyKey } from "./family.js";
import {
  domainFailure,
  DRAFT_STATUS,
  type DomainFailure,
  type DraftStatus,
  type Provenance,
  type TaskFamily,
  type TrajectorySketch,
} from "../../../../domains/shared/types.js";

export const DEFAULT_WORKFLOW_MIN_REPEATS = 2;

export type WorkflowEpisode = {
  readonly id: string;
  readonly taskFamily: TaskFamily;
  readonly trajectory: TrajectorySketch;
  readonly nodeInputs: Readonly<Record<string, string>>;
  readonly nodeOutputs: Readonly<Record<string, string>>;
  readonly fallback: string;
  readonly outcome: "success" | "failure";
};

export type WorkflowNode = {
  readonly id: string;
  readonly input: string;
  readonly output: string;
};

export type WorkflowTransition = {
  readonly from: string;
  readonly to: string;
};

export type WorkflowBudget = {
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly maxWallMs: number;
};

export type WorkflowCheckpoint = {
  readonly afterNode: string;
  readonly check: string;
};

export type WorkflowFallback = {
  readonly on: string;
  readonly goto: string;
};

export type WorkflowDraft = {
  readonly kind: "workflow";
  readonly status: DraftStatus;
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly nodes: readonly WorkflowNode[];
  readonly transitions: readonly WorkflowTransition[];
  readonly budget: WorkflowBudget;
  readonly verificationCheckpoints: readonly WorkflowCheckpoint[];
  readonly failureFallback: readonly WorkflowFallback[];
  readonly mutableFields: readonly string[];
  readonly provenance: Provenance;
  readonly source: string;
  readonly identity: string;
  /** Absent only on pre-v1 legacy drafts. It never derives execution permission. */
  readonly taskFamily?: TaskFamily;
  readonly supportingObservationRefs?: readonly string[];
  readonly failureObservationRefs?: readonly string[];
  readonly positiveRules: readonly string[];
  readonly negativeRules: readonly string[];
  readonly permissionClaim: false;
  readonly teamTopologyChanged: false;
  readonly command: BoardCommandDraft;
};

export type WorkflowInduceResult =
  | { readonly kind: "draft"; readonly draft: WorkflowDraft }
  | DomainFailure;

export type WorkflowEditPatch = {
  readonly budget?: WorkflowBudget;
  readonly failureFallback?: readonly WorkflowFallback[];
};

export function induceWorkflow(
  episodes: readonly WorkflowEpisode[],
  existingVersions: readonly number[] = [],
): WorkflowInduceResult {
  const smuggled = scanForbiddenBody(
    episodes.flatMap((episode) => [
      ...episode.trajectory.nodeIds,
      episode.fallback,
      ...Object.values(episode.nodeInputs),
      ...Object.values(episode.nodeOutputs),
    ]),
  );
  if (smuggled.length > 0) {
    return domainFailure(
      "forbidden_payload",
      "workflow cannot carry permission, download, or tool switch",
      smuggled,
    );
  }

  if (episodes.length < DEFAULT_WORKFLOW_MIN_REPEATS) {
    return domainFailure(
      "needs_more_evidence",
      "workflow induction needs repeated node/transition evidence",
    );
  }

  const family = episodes[0]?.taskFamily;
  const firstNodes = episodes[0]?.trajectory.nodeIds;
  if (family === undefined || firstNodes === undefined || firstNodes.length < 2) {
    return domainFailure("needs_more_evidence", "trajectories lack stable nodes");
  }

  const repeats = episodes.filter((episode) =>
    workflowFamilyKey(episode.taskFamily) === workflowFamilyKey(family)
      && sameNodes(episode.trajectory.nodeIds, firstNodes),
  );
  if (repeats.length < DEFAULT_WORKFLOW_MIN_REPEATS) {
    return domainFailure(
      "needs_more_evidence",
      "node sequences are not stable across episodes",
    );
  }

  if (repeats.every((episode) => episode.trajectory.hadFailureRecovery === false)) {
    return domainFailure(
      "needs_more_evidence",
      "workflow drafts must include failure/fallback experience",
    );
  }

  const failed = repeats.find((episode) => episode.outcome === "failure");
  const successful = repeats.find((episode) => episode.outcome === "success");
  if (failed === undefined || successful === undefined) {
    return domainFailure(
      "needs_more_evidence",
      "positive and negative trajectories are both required",
    );
  }

  const nodes: WorkflowNode[] = firstNodes.map((nodeId) => ({
    id: nodeId,
    input: successful.nodeInputs[nodeId] ?? `${nodeId}.in`,
    output: successful.nodeOutputs[nodeId] ?? `${nodeId}.out`,
  }));
  const transitions: WorkflowTransition[] = [];

  for (let index = 0; index < firstNodes.length - 1; index += 1) {
    const from = firstNodes[index];
    const to = firstNodes[index + 1];
    if (from !== undefined && to !== undefined) {
      transitions.push({ from, to });
    }
  }

  const lastNode = firstNodes[firstNodes.length - 1] ?? "end";
  const version = Math.max(0, ...existingVersions) + 1;
  const identity = ruleIdentity(firstNodes);
  const id = shortId("wf", [workflowFamilyKey(family), String(version), identity]);
  const draft: WorkflowDraft = {
    kind: "workflow",
    status: DRAFT_STATUS,
    id,
    name: `${family.intentClass}-flow`,
    version,
    nodes,
    transitions,
    budget: {
      maxSteps: firstNodes.length + 2,
      maxTokens: 8000,
      maxWallMs: 120000,
    },
    verificationCheckpoints: [
      { afterNode: lastNode, check: `${family.checkKind} must pass` },
    ],
    failureFallback: [{ on: "node_failure", goto: failed.fallback }],
    mutableFields: ["budget.maxSteps", "budget.maxTokens", "failureFallback"],
    provenance: {
      source: "inferred_from_observations",
      observationRefs: repeats.map((episode) => episode.id),
      createdBy: "workflow_inducer",
    },
    source: "trajectory-induction",
    identity,
    taskFamily: { ...family },
    supportingObservationRefs: repeats.filter((episode) => episode.outcome === "success")
      .map((episode) => episode.id),
    failureObservationRefs: repeats.filter((episode) => episode.outcome === "failure")
      .map((episode) => episode.id),
    positiveRules: transitions.map((item) => `take ${item.from} -> ${item.to}`),
    negativeRules: [`on failure goto ${failed.fallback}`],
    permissionClaim: false,
    teamTopologyChanged: false,
    command: submitDraftCommand("workflow", id),
  };

  return { kind: "draft", draft };
}

function sameNodes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

export function renderWorkflowMarkdown(draft: WorkflowDraft): string {
  return [
    `# ${draft.name} v${draft.version}`,
    "## Nodes",
    ...draft.nodes.map((node) => `- ${node.id}: ${node.input} -> ${node.output}`),
    "## Transitions",
    ...draft.transitions.map((item) => `- ${item.from} -> ${item.to}`),
    `Budget: steps=${draft.budget.maxSteps} tokens=${draft.budget.maxTokens}`,
    "## Fallback",
    ...draft.failureFallback.map((item) => `- ${item.on} -> ${item.goto}`),
    "## Positive rules",
    ...draft.positiveRules.map((rule) => `- ${rule}`),
    "## Negative rules",
    ...draft.negativeRules.map((rule) => `- ${rule}`),
    "## Evidence",
    `Supporting observations: ${(draft.supportingObservationRefs ?? []).join(", ")}`,
    `Failure observations: ${(draft.failureObservationRefs ?? []).join(", ")}`,
  ].join("\n");
}

export function withdrawWorkflow(id: string): BoardCommandDraft {
  return submitWithdrawCommand("workflow", id);
}

/** Typed convenience API. Invalid caller patches throw; untrusted edits use applyWorkflowMutation. */
export function editWorkflow(draft: WorkflowDraft, patch: WorkflowEditPatch): WorkflowDraft {
  const failure = validateWorkflowRevision(draft, patch);
  if (failure !== undefined) {
    throw new TypeError(failure.reason);
  }

  const version = draft.version + 1;
  const budget = patch.budget ?? draft.budget;
  const failureFallback = patch.failureFallback ?? draft.failureFallback;
  const id = shortId("wf", [draft.id, String(version), JSON.stringify({ budget, failureFallback })]);

  return {
    ...draft,
    id,
    version,
    budget: { ...budget },
    failureFallback: failureFallback.map((item) => ({ ...item })),
    negativeRules: patch.failureFallback === undefined ? draft.negativeRules
      : failureFallback.map((item) => `on ${item.on} goto ${item.goto}`),
    command: submitDraftCommand("workflow", id),
  };
}

/** One validity policy for legacy edit, mutation and the Board mapping boundary. */
export function validateWorkflowRevision(
  draft: WorkflowDraft,
  patch: WorkflowEditPatch = {},
): DomainFailure | undefined {
  const budget = patch.budget ?? draft.budget;
  if (![budget.maxSteps, budget.maxTokens, budget.maxWallMs]
    .every((value) => Number.isSafeInteger(value) && value > 0)) {
    return domainFailure("mutation_rejected", "workflow budgets must be positive safe integers");
  }

  const fallback = patch.failureFallback ?? draft.failureFallback;
  const invalid = fallback.length === 0 || fallback.some((item) =>
    item.on.trim().length === 0 || !draft.nodes.some((node) => node.id === item.goto));
  if (invalid) {
    return domainFailure("mutation_rejected", "recovery paths must name an existing node and a failure condition");
  }

  const forbidden = scanForbiddenBody(fallback.flatMap((item) => [item.on, item.goto]));

  return forbidden.length === 0 ? undefined
    : domainFailure("forbidden_payload", "recovery paths cannot carry authority claims", forbidden);
}
