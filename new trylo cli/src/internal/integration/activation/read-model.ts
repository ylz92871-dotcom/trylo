import type { BoardState } from "../../learning/control/state.js";
import {
  listProductionTools,
  type ProductionSearchInput,
  type ProductionTool,
} from "../../tooling/catalog/production-search.js";
import type {
  MyToolsEntry,
  ToolPackageVersion,
  ValidationRecord,
} from "../../tooling/contract/types.js";
import type { ContributionStatus, ProjectorInput } from "../../learning/agent/subsystems/tool/assets/my-tools/projector.js";
import { projectMyTools } from "../../learning/agent/subsystems/tool/assets/my-tools/projector.js";
import type { MappingResult } from "../contract/rejection.js";
import { projectToolActivationView } from "./view.js";

/**
 * Board → Tooling 只读视图的接线层。
 *
 * 两条硬规则：
 * 1. 激活状态只来自 Board `ActivationRecord`，catalog 状态只描述工具自身的验证进度；
 * 2. 这里没有任何 setter，也没有第二个 active pointer——My Tools 与生产工具搜索
 *    都只是 Board 状态的投影。
 */

export type BoardToolingInput = {
  readonly board: BoardState;
  readonly packages: readonly ToolPackageVersion[];
  readonly validations: readonly ValidationRecord[];
  readonly minSequence?: number;
};

export type MyToolsBoardInput = BoardToolingInput & {
  readonly contributionByPackage?: Readonly<Record<string, ContributionStatus>>;
  readonly healthByPackage?: Readonly<Record<string, "healthy" | "degraded" | "unknown">>;
  readonly effectByPackage?: Readonly<Record<string, "improved" | "regressed" | "unknown">>;
};

export type ProductionToolsBoardInput = BoardToolingInput & {
  readonly descriptions: Readonly<Record<string, string>>;
};

export function projectMyToolsFromBoard(
  input: MyToolsBoardInput,
): MappingResult<readonly MyToolsEntry[]> {
  const activations = projectToolActivationView({
    records: input.board.activations,
    assets: input.board.assets,
    proposals: input.board.proposals,
    ...(input.minSequence === undefined ? {} : { minSequence: input.minSequence }),
  });
  if (!activations.ok) {
    return activations;
  }

  const projectorInput: ProjectorInput = {
    packages: input.packages,
    validations: input.validations,
    activations: activations.value,
    contributionByPackage: input.contributionByPackage ?? {},
    ...(input.healthByPackage === undefined ? {} : { healthByPackage: input.healthByPackage }),
    ...(input.effectByPackage === undefined ? {} : { effectByPackage: input.effectByPackage }),
  };

  return { ok: true, value: projectMyTools(projectorInput) };
}

export function productionToolsFromBoard(
  input: ProductionToolsBoardInput,
): MappingResult<readonly ProductionTool[]> {
  const activations = projectToolActivationView({
    records: input.board.activations,
    assets: input.board.assets,
    proposals: input.board.proposals,
    ...(input.minSequence === undefined ? {} : { minSequence: input.minSequence }),
  });
  if (!activations.ok) {
    return activations;
  }

  const searchInput: ProductionSearchInput = {
    packages: input.packages,
    validations: input.validations,
    activations: activations.value,
    descriptions: input.descriptions,
  };

  return { ok: true, value: listProductionTools(searchInput) };
}
