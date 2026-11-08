import type { MyToolsEntry, PackageOrigin } from "../../../../../tooling/contract/types.js";

/**
 * 「我的工具」的来源与优化标识（P05 工具学习规格 §9）。
 *
 * 这一层**只派生、不新增状态**。P01 WP-D 冻结的 `MyToolsEntry` 已经把要说的事都
 * 记下了：`origin`（`direct` / `optimized` / `self_created`）就是来源，`previousVersionId`
 * 就是「从哪一版优化来的」。所以这里没有第二份可写状态，只有一张给人看的投影——
 * WP-D 读模型那条「本地不得出现可写 `active` 字段」的纪律，在这一层继续成立。
 *
 * 三个来源与 `origin` 的对应是**满射且无歧义**的：
 *
 * ```
 * direct       → downloaded      （从开源平台直接拿的，不带标识）
 * optimized    → downloaded      + optimized: true  （改过的，带优化标识）
 * self_created → crystallized    （Agent 自己结晶的，不是从哪一版改来的）
 * builtin      → builtin         （内置/工作区工具，根本没有包版本）
 * ```
 *
 * 「优化标识」只对 `optimized` 亮。`self_created` 不带它——它不是「某个上游的改进
 * 版」，没有可提交贡献的目标仓库；给它一个提交按钮会指向一个不存在的上游。
 */

export type ToolSource = "builtin" | "downloaded" | "crystallized";

export type MyToolView = {
  readonly identity: string;
  /** 包版本坐标；内置工具没有，所以是 `builtin:` 前缀的合成名。 */
  readonly packageVersionId: string;
  readonly source: ToolSource;
  /** 优化标识：只有「从某个上游改出来的」才亮。 */
  readonly optimized: boolean;
  /** 优化来源（被改的那一版）。非优化工具没有这个键，而不是空串。 */
  readonly optimizedFrom?: string;
  readonly licenseSpdx: string;
  readonly upstreamUrl: string;
  readonly capabilities: readonly string[];
  /** 能不能点「提交开源贡献」。只有带优化标识的才有上游可交。 */
  readonly contributionReady: boolean;
  /** 能不能回滚到上一版。 */
  readonly rollbackAvailable: boolean;
};

export function sourceOf(origin: PackageOrigin): ToolSource {
  switch (origin) {
    case "direct":
    case "optimized":
      return "downloaded";
    case "self_created":
      return "crystallized";
  }
}

export function viewOf(entry: MyToolsEntry): MyToolView {
  const source = sourceOf(entry.origin);
  const optimized = entry.origin === "optimized";
  const optimizedFrom = optimized ? entry.previousVersionId : undefined;

  return {
    identity: entry.identity,
    packageVersionId: entry.packageVersionId,
    source,
    optimized,
    ...(optimizedFrom === undefined ? {} : { optimizedFrom }),
    licenseSpdx: entry.licenseSpdx,
    upstreamUrl: entry.upstreamUrl,
    capabilities: entry.capabilities,
    // 提交贡献要有两件事：改过（有优化标识）且知道往哪交（有上游地址）。
    contributionReady: optimized && entry.upstreamUrl.length > 0,
    rollbackAvailable: entry.rollbackAvailable,
  };
}

/**
 * 内置工具那几条。
 *
 * 它们不走包目录，所以没有 `MyToolsEntry` 可派生——但仍然要从同一个口出去，否则
 * 「我的工具」面板会漏掉一半（用户看到的工具列表不该取决于它是不是下载来的）。
 * 名字由调用方给（工作区工具的真实名字），这一层不猜。
 */
export function builtinViewOf(name: string): MyToolView {
  return {
    identity: name,
    packageVersionId: `builtin:${name}`,
    source: "builtin",
    optimized: false,
    licenseSpdx: "UNLICENSED",
    upstreamUrl: "",
    capabilities: [],
    contributionReady: false,
    rollbackAvailable: false,
  };
}

/** 一张表：内置在前，包在后，各自保持调用方给的顺序。 */
export function myToolsView(
  entries: readonly MyToolsEntry[],
  builtinNames: readonly string[],
): readonly MyToolView[] {
  return [...builtinNames.map(builtinViewOf), ...entries.map(viewOf)];
}
