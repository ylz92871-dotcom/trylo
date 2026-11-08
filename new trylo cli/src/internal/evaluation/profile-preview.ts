import { canonicalJson } from "../learning/domains/shared/hash.js";
import type { AssetKind, ScopeKind } from "../learning/domains/shared/types.js";
import { domainFailure, type DomainFailure } from "../learning/domains/shared/types.js";

export type PreviewAsset = {
  readonly id: string;
  readonly kind: AssetKind;
  readonly origin: "user_explicit" | "inferred";
  readonly sourceMark: string;
  readonly body: string;
  readonly constraintKey?: string;
  readonly constraintValue?: string;
  readonly scopeKind?: ScopeKind;
};

export type CurrentInstruction = {
  readonly text: string;
  readonly constraintKey?: string;
  readonly constraintValue?: string;
};

export type TrimRecord = {
  readonly id: string;
  readonly reason: "token_budget" | "conflict_with_current" | "duplicate" | "scope_leakage";
};

export type RenderedLine = {
  readonly order: number;
  readonly sourceMark: string;
  readonly text: string;
  readonly untrimmable: boolean;
};

export type ProfilePreview = {
  readonly currentInstruction: string;
  readonly applied: readonly PreviewAsset[];
  readonly rendered: readonly RenderedLine[];
  readonly conflicts: readonly string[];
  readonly trimmed: readonly TrimRecord[];
  readonly duplicates: readonly string[];
  readonly scopeLeaks: readonly string[];
  readonly tokenBudget: number;
  readonly tokensUsed: number;
  readonly currentInstructionPreserved: true;
  readonly snapshot: {
    readonly userRules: readonly PreviewAsset[];
    readonly promptPatches: readonly PreviewAsset[];
    readonly skills: readonly PreviewAsset[];
    readonly workflows: readonly PreviewAsset[];
  };
  readonly deterministicFingerprint: string;
};

const KIND_PRIORITY: Record<AssetKind, number> = {
  user_rule: 0,
  prompt_patch: 1,
  skill: 2,
  workflow: 3,
};

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function renderProfilePreview(input: {
  readonly currentInstruction: CurrentInstruction;
  readonly assets: readonly PreviewAsset[];
  readonly tokenBudget: number;
  readonly previewScope?: ScopeKind;
}): ProfilePreview | DomainFailure {
  if (input.assets.some((asset) => isHiddenCot(asset.body))) {
    return domainFailure("hidden_cot_rejected", "hidden chain-of-thought cannot be a profile asset");
  }

  const previewScope = input.previewScope ?? "task";
  const ordered = [...input.assets].sort(compareAssets);
  const conflicts: string[] = [];
  const duplicates: string[] = [];
  const scopeLeaks: string[] = [];
  const kept: PreviewAsset[] = [];
  const trimmed: TrimRecord[] = [];
  const seenBodies = new Set<string>();

  for (const asset of ordered) {
    if (conflictsWithCurrent(input.currentInstruction, asset)) {
      conflicts.push(asset.id);
      trimmed.push({ id: asset.id, reason: "conflict_with_current" });
      continue;
    }

    if (leaksScope(previewScope, asset.scopeKind)) {
      scopeLeaks.push(asset.id);
      trimmed.push({ id: asset.id, reason: "scope_leakage" });
      continue;
    }

    const dupKey = `${asset.kind}|${asset.body}`;
    if (seenBodies.has(dupKey)) {
      duplicates.push(asset.id);
      trimmed.push({ id: asset.id, reason: "duplicate" });
      continue;
    }

    seenBodies.add(dupKey);
    kept.push(asset);
  }

  const currentTokens = estimateTokens(input.currentInstruction.text);
  let used = currentTokens;
  const applied: PreviewAsset[] = [];

  for (const asset of kept) {
    const cost = estimateTokens(asset.body);
    if (used + cost <= input.tokenBudget) {
      applied.push(asset);
      used += cost;
    } else {
      trimmed.push({ id: asset.id, reason: "token_budget" });
    }
  }

  const rendered: RenderedLine[] = [
    {
      order: 0,
      sourceMark: "current_instruction",
      text: input.currentInstruction.text,
      untrimmable: true,
    },
    ...applied.map((asset, index) => ({
      order: index + 1,
      sourceMark: asset.sourceMark,
      text: asset.body,
      untrimmable: false,
    })),
  ];
  const preview: ProfilePreview = {
    currentInstruction: input.currentInstruction.text,
    applied,
    rendered,
    conflicts,
    trimmed,
    duplicates,
    scopeLeaks,
    tokenBudget: input.tokenBudget,
    tokensUsed: used,
    currentInstructionPreserved: true,
    snapshot: {
      userRules: applied.filter((asset) => asset.kind === "user_rule"),
      promptPatches: applied.filter((asset) => asset.kind === "prompt_patch"),
      skills: applied.filter((asset) => asset.kind === "skill"),
      workflows: applied.filter((asset) => asset.kind === "workflow"),
    },
    deterministicFingerprint: canonicalJson({
      currentInstruction: input.currentInstruction.text,
      rendered,
      applied: applied.map((asset) => asset.id),
      trimmed,
      conflicts,
      duplicates,
      scopeLeaks,
    }),
  };

  return preview;
}

function compareAssets(left: PreviewAsset, right: PreviewAsset): number {
  const originRank = left.origin === "user_explicit" ? 0 : 1;
  const otherOrigin = right.origin === "user_explicit" ? 0 : 1;
  if (originRank !== otherOrigin) {
    return originRank - otherOrigin;
  }

  if (KIND_PRIORITY[left.kind] !== KIND_PRIORITY[right.kind]) {
    return KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
  }

  return left.id.localeCompare(right.id);
}

function conflictsWithCurrent(
  current: CurrentInstruction,
  asset: PreviewAsset,
): boolean {
  if (current.constraintKey === undefined || asset.constraintKey === undefined) {
    return false;
  }
  return (
    current.constraintKey === asset.constraintKey &&
    current.constraintValue !== asset.constraintValue
  );
}

function isHiddenCot(body: string): boolean {
  return body.startsWith("HIDDEN_COT") || body.startsWith("thinking:");
}

function leaksScope(previewScope: ScopeKind, assetScope: ScopeKind | undefined): boolean {
  if (assetScope === undefined) {
    return false;
  }

  if (assetScope === "user_global" && previewScope !== "user_global") {
    return true;
  }

  return false;
}
