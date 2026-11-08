import type {
  ActivationRecord,
  LearningAssetVersion,
} from "../control/contracts.js";
import type {
  ExecutionProfileSnapshot,
  ProfileDiagnostic,
  ProfileRef,
  ProfileRule,
  ToolBindingRef,
} from "../../contract/profile.js";
import { contentHashOf } from "../control/hash.js";
import type { BoardState } from "../control/state.js";

export type ResolveInput = {
  readonly scope: string;
  readonly currentInstruction?: string;
};

const SCOPE_RANK: Readonly<Record<string, number>> = {
  user: 100,
  project: 80,
  repo: 60,
  global: 20,
  candidate: 0,
};

export function resolveProfile(
  state: BoardState,
  input: ResolveInput,
): ExecutionProfileSnapshot {
  const diagnostics: ProfileDiagnostic[] = [];

  if (input.currentInstruction !== undefined) {
    diagnostics.push({
      code: "current_instruction_precedes_assets",
      message: "current explicit instruction outranks historical assets",
    });
  }

  const active = state.activations.filter((item) => item.pointer === "active");

  // Resolve active pointers into one immutable view for the execution boundary.
  const userRules: ProfileRule[] = [];
  const promptPatches: ProfileRule[] = [];
  const skillRefs: ProfileRef[] = [];
  const toolBindings: ToolBindingRef[] = [];
  const requiredCheckRefs: string[] = [];
  const assetVersions: Record<string, string> = {};
  let workflowRef: ExecutionProfileSnapshot["workflowRef"];
  const winners = selectWinners(active, diagnostics);

  for (const activation of winners) {
    const asset = state.assets.find((item) => item.versionId === activation.versionId);
    if (asset === undefined) {
      diagnostics.push({ code: "asset_missing", message: activation.versionId });
      continue;
    }

    assetVersions[`${activation.scope}:${activation.assetKind}`] = activation.versionId;
    assignAsset(asset, activation, {
      userRules,
      promptPatches,
      skillRefs,
      toolBindings,
      requiredCheckRefs,
      setWorkflow: (ref) => {
        workflowRef = ref;
      },
    });
  }

  return freezeSnapshot(state.sequence, input.scope, {
    userRules,
    promptPatches,
    skillRefs,
    workflowRef,
    toolBindings,
    requiredCheckRefs,
    assetVersions,
    diagnostics,
  });
}

export function emptySnapshot(
  scope: string,
  sequence: number,
  mode: ExecutionProfileSnapshot["learningMode"],
  diagnostics: ReadonlyArray<ProfileDiagnostic>,
): ExecutionProfileSnapshot {
  return freezeSnapshot(sequence, scope, {
    userRules: [],
    promptPatches: [],
    skillRefs: [],
    toolBindings: [],
    requiredCheckRefs: [],
    assetVersions: {},
    diagnostics,
    learningMode: mode,
  });
}

function assignAsset(
  asset: LearningAssetVersion,
  activation: ActivationRecord,
  buckets: {
    userRules: ProfileRule[];
    promptPatches: ProfileRule[];
    skillRefs: ProfileRef[];
    toolBindings: ToolBindingRef[];
    requiredCheckRefs: string[];
    setWorkflow: (ref: { versionId: string; scope: string }) => void;
  },
): void {
  const rule = { versionId: asset.versionId, scope: activation.scope, text: textOf(asset) };
  switch (asset.kind) {
    case "user_rule":
      buckets.userRules.push(rule);
      return;
    case "prompt_patch":
      buckets.promptPatches.push(rule);
      return;
    case "skill":
      buckets.skillRefs.push({ versionId: asset.versionId, scope: activation.scope });
      return;
    case "workflow":
      buckets.setWorkflow({ versionId: asset.versionId, scope: activation.scope });
      return;
    case "tool_binding":
      buckets.toolBindings.push({
        versionId: asset.versionId,
        toolId: textOf(asset),
        scope: activation.scope,
      });
      return;
    case "verification_recipe":
      buckets.requiredCheckRefs.push(asset.versionId);
      return;
    default:
      return;
  }
}

function selectWinners(
  active: ReadonlyArray<ActivationRecord>,
  diagnostics: ProfileDiagnostic[],
): ActivationRecord[] {
  const grouped = new Map<string, ActivationRecord[]>();

  for (const activation of active) {
    const group = grouped.get(activation.assetKind) ?? [];
    group.push(activation);
    grouped.set(activation.assetKind, group);
  }

  const winners: ActivationRecord[] = [];

  for (const [, group] of grouped) {
    const ranked = [...group].sort(compareActivation);
    const top = ranked[0];
    const rival = ranked[1];

    if (top === undefined) {
      continue;
    }

    if (rival !== undefined && scopeRank(rival.scope) === scopeRank(top.scope)) {
      // Equal scope authority is a conflict; lexical ordering must not decide policy.
      diagnostics.push({
        code: "conflict_unresolved",
        message: `${top.assetKind} ${top.versionId} vs ${rival.versionId}`,
      });
      continue;
    }

    winners.push(top);
  }

  return winners;
}

function compareActivation(a: ActivationRecord, b: ActivationRecord): number {
  const rank = scopeRank(b.scope) - scopeRank(a.scope);
  if (rank !== 0) {
    return rank;
  }
  return a.versionId.localeCompare(b.versionId);
}

function scopeRank(scope: string): number {
  return SCOPE_RANK[scope] ?? 40;
}

function textOf(asset: LearningAssetVersion): string {
  if (typeof asset.content === "string") {
    return asset.content;
  }

  if (
    typeof asset.content === "object" &&
    asset.content !== null &&
    "text" in asset.content &&
    typeof (asset.content as { text: unknown }).text === "string"
  ) {
    return (asset.content as { text: string }).text;
  }

  return asset.versionId;
}

function freezeSnapshot(
  sequence: number,
  scope: string,
  parts: {
    userRules: ReadonlyArray<ProfileRule>;
    promptPatches: ReadonlyArray<ProfileRule>;
    skillRefs: ExecutionProfileSnapshot["skillRefs"];
    workflowRef?: ExecutionProfileSnapshot["workflowRef"];
    toolBindings: ReadonlyArray<ToolBindingRef>;
    requiredCheckRefs: ReadonlyArray<string>;
    assetVersions: Readonly<Record<string, string>>;
    diagnostics: ReadonlyArray<ProfileDiagnostic>;
    learningMode?: ExecutionProfileSnapshot["learningMode"];
  },
): ExecutionProfileSnapshot {
  const body = {
    scope,
    userRules: parts.userRules,
    promptPatches: parts.promptPatches,
    skillRefs: parts.skillRefs,
    toolBindings: parts.toolBindings,
    requiredCheckRefs: parts.requiredCheckRefs,
    assetVersions: parts.assetVersions,
    createdFromBoardSequence: sequence,
    learningMode: parts.learningMode ?? "full",
    diagnostics: parts.diagnostics,
    ...(parts.workflowRef !== undefined ? { workflowRef: parts.workflowRef } : {}),
  };

  // Hash the complete view so its identity changes with any resolved asset.
  const snapshotHash = contentHashOf(body);

  return {
    ...body,
    snapshotId: `snap:${snapshotHash.slice(0, 16)}`,
    snapshotHash,
  };
}
