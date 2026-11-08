import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import type { ObservationKind, ToolLearningObservation } from "../../../../../../tooling/contract/types.js";
import type { FailureFact, TaskScope } from "./types.js";

/**
 * 源① 的原料 → 源② 的入口（规格 §2 表格前两行之间的那一层）。
 *
 * 实测缺口：拍级上报的是 `{工具, 失败码, 输入指纹}`，而既有的缺口检测器吃的是
 * `ToolLearningObservation[]`（带 `taskFamily`/`capability`/`criticality`）。
 * 缺的是任务坐标和失败码的语义，所以这个适配器只做两件事：补坐标、翻译码。
 *
 * 翻译决定了两源不会退化成同一个东西：`unknown_tool` 是「没有工具能做」，
 * `ENOENT` 是「这平台上跑不了」，`invalid_arguments` 是「描述/模式让我用错」——
 * 三者都导致一次失败，但决策树对它们的处置完全不同。缺省落到 `tool_failure`，
 * 也就是「不知道原因的一次失败」，它只喂源①，不假装自己懂原因。
 */

const NOT_FOUND_CODES: ReadonlySet<string> = new Set(["unknown_tool", "tool_not_found", "not_found"]);

const PLATFORM_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EFTYPE",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "platform_incompatible",
]);

const SCHEMA_CODES: ReadonlySet<string> = new Set([
  "invalid_arguments",
  "schema_friction",
  "validation_failed",
  "bad_arguments",
]);

export function observationKindFor(code: string): ObservationKind {
  if (NOT_FOUND_CODES.has(code)) {
    return "tool_not_found";
  }

  if (PLATFORM_CODES.has(code)) {
    return "platform_incompatible";
  }

  if (SCHEMA_CODES.has(code)) {
    return "schema_friction";
  }

  return "tool_failure";
}

/**
 * 补坐标。
 *
 * **重复必须保留。** 缺口检测数的是「同一组里坏了几条」，去重会把它冻在 1 上，
 * 于是「重复失败」这条永远不成立——这是这一层最容易犯又最看不出来的错，所以
 * `observationId` 里带上序号，逐条唯一是用例钉住的。
 *
 * 坐标缺失是**非法输入**（fail closed），不是「用空串凑合」：一个没有 capability
 * 的缺口描述不了任何事，放它过去只会让下游的提议变成一句空话。
 */
export function observationsFromFailures(
  facts: readonly FailureFact[],
  scope: TaskScope,
  recordedAt: string,
): Result<readonly ToolLearningObservation[], "invalid_scope"> {
  if (scope.taskFamily.length === 0 || scope.capability.length === 0) {
    return err("invalid_scope", "taskFamily and capability are required");
  }
  return ok(
    facts.map((fact, index) => ({
      observationId: `obs:${fact.tool}:${fact.code}:${fact.fingerprint}:${index}`,
      kind: observationKindFor(fact.code),
      capability: scope.capability,
      taskFamily: scope.taskFamily,
      criticality: scope.criticality,
      fallbackAvailable: scope.fallbackAvailable,
      recordedAt,
      toolName: fact.tool,
    })),
  );
}
