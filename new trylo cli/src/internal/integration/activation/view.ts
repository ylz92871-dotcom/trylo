import {
  activationKey,
  ACTIVATION_POINTERS,
  type ActivationRecord,
  type LearningAssetVersion,
  type LearningProposal,
} from "../../learning/control/contracts.js";
import type { BoardActivationView } from "../../tooling/contract/types.js";
import type { MappingFailure, MappingResult } from "../contract/rejection.js";
import { mapped, rejected } from "../contract/rejection.js";
import { isNonEmptyString, isOneOf, isPlainRecord } from "../shared/validate.js";

const TOOL_ASSET_KINDS = ["tool_package", "tool_binding"] as const;

export type ActivationViewInput = {
  readonly records: readonly ActivationRecord[];
  /**
   * 外审 P0-3：投影必须读取并验证 canonical 资产/提案关系。
   * 每条工具激活记录都要能解析到一条 canonical 资产（versionId 精确匹配），
   * 资产要能解析到产出它的提案，且 kind/scope 一致；
   * 缺映射、类型不符或 ID 冲突一律 fail closed——伪造的 ActivationRecord
   * 不能凭空变成生产工具视图。
   */
  readonly assets: readonly LearningAssetVersion[];
  readonly proposals: readonly LearningProposal[];
  /**
   * 调用方已经消费过的最大 board sequence。任何 `boardSequence <= minSequence`
   * 的记录都视为陈旧投影，必须 fail closed——陈旧投影覆盖新状态等同于静默回滚。
   */
  readonly minSequence?: number;
};

/** 跨记录的去重状态：activation 键与已桥接的 packageVersionId 各一套。 */
type SeenActivationKeys = {
  readonly keys: Set<string>;
  readonly versions: Set<string>;
};

type RecordProjection =
  | { readonly ok: true; readonly view: BoardActivationView }
  | { readonly ok: false; readonly failure: MappingFailure };

/**
 * Board `ActivationRecord` → Tooling 只读 `BoardActivationView`。
 *
 * 只投影工具相关资产（tool_package / tool_binding），其他资产种类与工具视图无关，跳过。
 * `packageVersionId` 不再是 `record.versionId` 的改名（外审 P0-3）：它必须来自
 * canonical 资产 content 中显式声明的 `packageVersionId` —— canonical 资产版本 id
 * 与 Tooling 包版本 id 是两个合同，投影负责显式桥接并验证两边关系。
 */
export function projectToolActivationView(
  input: ActivationViewInput,
): MappingResult<readonly BoardActivationView[]> {
  const seen: SeenActivationKeys = { keys: new Set(), versions: new Set() };
  const views: BoardActivationView[] = [];

  for (const record of input.records) {
    if (!(TOOL_ASSET_KINDS as readonly string[]).includes(record.assetKind)) {
      continue;
    }

    const projected = projectActivationRecord(input, record, seen);
    if (!projected.ok) {
      return { ok: false, reason: projected.failure.reason, detail: projected.failure.detail };
    }

    views.push(projected.view);
  }

  return mapped(views);
}

function projectActivationRecord(
  input: ActivationViewInput,
  record: ActivationRecord,
  seen: SeenActivationKeys,
): RecordProjection {
  const pointerFailure = checkPointer(record);
  if (pointerFailure !== undefined) {
    return { ok: false, failure: pointerFailure };
  }

  const asset = input.assets.find((item) => item.versionId === record.versionId);
  if (asset === undefined) {
    return fail("missing_asset_link", `activation ${record.versionId} has no canonical asset behind it`);
  }

  if (asset.kind !== record.assetKind) {
    return fail(
      "invalid_activation",
      `asset kind ${asset.kind} does not match activation kind ${record.assetKind}`,
    );
  }

  if (asset.scope !== record.scope) {
    return fail(
      "invalid_activation",
      `asset scope ${asset.scope} does not match activation scope ${record.scope}`,
    );
  }

  const proposal = input.proposals.find(
    (item) => item.proposalId === asset.createdFromProposalId,
  );
  if (proposal === undefined) {
    return fail(
      "missing_asset_link",
      `asset ${asset.versionId} does not trace back to a canonical proposal`,
    );
  }

  if (proposal.assetKind !== record.assetKind || proposal.scope !== record.scope) {
    return fail(
      "invalid_activation",
      "the producing proposal disagrees with the activation on kind or scope",
    );
  }

  if (!isPlainRecord(asset.content) || !isNonEmptyString(asset.content.packageVersionId)) {
    return fail(
      "missing_package_version",
      "the canonical tool asset does not declare the tooling packageVersionId it maps to",
    );
  }

  const packageVersionId = asset.content.packageVersionId;

  if (input.minSequence !== undefined && record.boardSequence <= input.minSequence) {
    return fail(
      "stale_sequence",
      `sequence ${String(record.boardSequence)} is not newer than ${String(input.minSequence)}`,
    );
  }

  const key = activationKey(record.scope, record.assetKind);
  if (seen.keys.has(key)) {
    return fail("duplicate_activation_key", key.replace("\u0000", "|"));
  }

  if (seen.versions.has(packageVersionId)) {
    return fail("duplicate_activation_key", packageVersionId);
  }

  seen.keys.add(key);
  seen.versions.add(packageVersionId);

  return {
    ok: true,
    view: {
      packageVersionId,
      scope: record.scope,
      state: record.pointer,
      boardSequence: record.boardSequence,
    },
  };
}

function checkPointer(record: ActivationRecord): MappingFailure | undefined {
  if (!isOneOf(ACTIVATION_POINTERS, record.pointer)) {
    return rejected("invalid_activation", `unknown activation pointer ${String(record.pointer)}`);
  }

  if (!isNonEmptyString(record.versionId)) {
    return rejected("missing_package_version", "activation record has no version id");
  }

  return undefined;
}

function fail(reason: MappingFailure["reason"], detail: string): RecordProjection {
  return { ok: false, failure: rejected(reason, detail) };
}
