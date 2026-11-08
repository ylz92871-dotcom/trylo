import { sha256Hex, shortId } from "../shared/hash.js";
import {
  type BehaviorCommitment,
  type BundlePointerState,
  type CompiledPolicyRule,
  type ImmutablePolicyBundle,
  type UserModelRecord,
} from "./contracts.js";

export type CompileBundleInput = {
  readonly userId: string;
  readonly commitments: readonly BehaviorCommitment[];
  readonly models: readonly UserModelRecord[];
  readonly previousBundle?: ImmutablePolicyBundle;
  /** 默认 shadow：编译产物先当影子，不代表已生效。 */
  readonly mode?: "shadow" | "active";
  readonly now?: number;
};

export type CompiledBundle = {
  readonly bundle: ImmutablePolicyBundle;
  readonly rules: readonly CompiledPolicyRule[];
};

function strengthFor(model: UserModelRecord): CompiledPolicyRule["strength"] {
  if (model.distance === "D2") {
    return "advisory";
  }

  if (model.truth.band === "high") {
    return "strong_default";
  }

  return "soft";
}

/**
 * 政策编译：只编译成不可变 bundle + 校验和。
 * 本模块没有 render，没有注入，没有 promptMessages，没有 resolve-at-run——
 * 那些是接线的活，明天谈。bundle 是可复核工件，不是运行时决策。
 * 只有 shadow/active 状态的承诺参与编译；candidate 需要先被接线方推进。
 */
export function compilePolicyBundle(input: CompileBundleInput): CompiledBundle {
  const now = input.now ?? Date.now();
  const mode = input.mode ?? "shadow";
  const bundleId = shortId("pb", [
    input.userId,
    String(input.previousBundle?.version ?? 0),
    String(now),
  ]);
  const rules: CompiledPolicyRule[] = [];

  for (const commitment of input.commitments) {
    if (commitment.state !== "shadow" && commitment.state !== "active") {
      continue;
    }

    const model = input.models.find((item) => item.id === commitment.userModelId);
    if (model === undefined || model.status !== "active") {
      continue;
    }

    rules.push({
      id: shortId("pol", [bundleId, commitment.id]),
      bundleId,
      domain: model.dimension,
      kind: "prompt_directive",
      strength: strengthFor(model),
      originMark: commitment.activation === "explicit" ? "explicit" : "inferred",
      instruction: commitment.behaviorDelta.adaptedBehavior,
      sourceUserModelIds: [model.id],
      sourceConclusionIds: [...model.derivedFromConclusionIds],
      sourceEvidenceIds: [...commitment.provenanceEvidenceIds],
      sourceCommitmentIds: [commitment.id],
      status: "active",
      version: commitment.version,
      createdAt: now,
    });
  }

  const checksum = sha256Hex(rules.map((rule) => `${rule.id}${rule.instruction}`).join(""));
  const bundle: ImmutablePolicyBundle = {
    id: bundleId,
    userId: input.userId,
    ruleIds: rules.map((rule) => rule.id),
    checksum,
    version: (input.previousBundle?.version ?? 0) + 1,
    ...(input.previousBundle === undefined ? {} : { previousBundleId: input.previousBundle.id }),
    status: mode === "active" ? "active" : "shadow",
    createdAt: now,
  };

  return { bundle, rules };
}

/** 校验和复核：ruleIds 全、内容一致才算数；对不上就拒收整个包。 */
export function verifyBundleChecksum(compiled: CompiledBundle): boolean {
  if (compiled.bundle.ruleIds.length !== compiled.rules.length) {
    return false;
  }

  const ids = new Set(compiled.rules.map((rule) => rule.id));
  if (!compiled.bundle.ruleIds.every((id) => ids.has(id))) {
    return false;
  }

  const checksum = sha256Hex(compiled.rules.map((rule) => `${rule.id}${rule.instruction}`).join(""));

  return checksum === compiled.bundle.checksum;
}

/**
 * current pointer 原子切换：纯函数，一次返回新状态。
 * 旧 current 包被标 retired（保留可复核），没有任何包被原地修改，
 * 也没有任何"上次编译一半"的中间态可观测。
 */
export function commitBundle(
  state: BundlePointerState,
  compiled: CompiledBundle,
): BundlePointerState {
  if (!verifyBundleChecksum(compiled)) {
    return state;
  }
  return {
    currentBundleId: compiled.bundle.id,
    bundles: [
      ...state.bundles.map((item) =>
        item.id === state.currentBundleId ? { ...item, status: "retired" as const } : item,
      ),
      compiled.bundle,
    ],
  };
}
