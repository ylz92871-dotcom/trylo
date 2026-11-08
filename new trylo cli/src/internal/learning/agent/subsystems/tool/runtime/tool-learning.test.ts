import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { MyToolsEntry } from "../../../../../tooling/contract/types.js";
import {
  builtinViewOf,
  myToolsView,
  sourceOf,
  viewOf,
  type MyToolView,
} from "./my-tools-view.js";
import { CONTRIBUTION_PLACEHOLDER, contributionPrompt } from "./contribution-prompt.js";

/**
 * 「我的工具」的标识与贡献助手（P05 工具学习规格 §9）。
 *
 * 两条硬门在这一个文件里：
 *
 *  - **派生，不新增状态。** 来源与优化标识全部从 P01 WP-D 冻结的 `MyToolsEntry`
 *    派生；不带优化标识的工具没有上游可交，所以它的提交按钮必须是灰的（不是
 *    「点了再说」）。
 *  - **贡献助手零 LLM、零自动携带。** 模板是死字符串，改动描述是用户自己填的
 *    占位符——没有任何一处会从轨迹或 diff 里自动摘内容带出去。
 */

/**
 * 扫描目标用 `process.cwd()` 而不是从 `import.meta.url` 反推仓库根：门禁与本地跑
 * 都在仓库根启动，而隔离编译的产物在仓库外——用 cwd 的话，这条用例在两种跑法下
 * 都指向同一份源文件，不会因为「产物在哪」而变成一条空转的假绿。
 */
const repoRoot = process.cwd();

function entry(over: Partial<MyToolsEntry> & Pick<MyToolsEntry, "identity" | "origin">): MyToolsEntry {
  return {
    packageVersionId: `pv:${over.identity}`,
    version: "1.0.0",
    sourceUrl: `https://github.com/o/${over.identity}`,
    upstreamUrl: `https://github.com/o/${over.identity}`,
    commit: "abc1234",
    licenseSpdx: "MIT",
    lifecycle: "shadow",
    capabilities: ["extract"],
    permissionNeeds: [],
    rollbackAvailable: false,
    contributionBundleStatus: "none",
    ...over,
  };
}

test("M1 三个来源与 origin 的对应是满射且无歧义", () => {
  assert.equal(sourceOf("direct"), "downloaded");
  assert.equal(sourceOf("optimized"), "downloaded");
  assert.equal(sourceOf("self_created"), "crystallized");
});

test("M2 直接下载的工具不带优化标识，也没有上游可交", () => {
  const view = viewOf(entry({ identity: "pdf-lib", origin: "direct" }));
  assert.equal(view.source, "downloaded");
  assert.equal(view.optimized, false);
  assert.equal("optimizedFrom" in view, false);
  assert.equal(view.contributionReady, false);
});

test("M3 优化过的工具带标识，且记住「从哪一版改来的」", () => {
  const view = viewOf(entry({ identity: "pdf-lib", origin: "optimized", previousVersionId: "pv:base" }));
  assert.equal(view.optimized, true);
  assert.equal(view.optimizedFrom, "pv:base");
  assert.equal(view.contributionReady, true);
});

test("M4 自己结晶出来的工具归 crystallized，但**不**带优化标识", () => {
  const view = viewOf(entry({ identity: "pdf-split", origin: "self_created" }));
  assert.equal(view.source, "crystallized");
  assert.equal(view.optimized, false, "它不是某个上游的改进版，给它提交按钮会指向不存在的仓库");
  assert.equal(view.contributionReady, false);
});

test("M5 改过但没有上游地址 → 提交按钮仍是灰的", () => {
  const view = viewOf(entry({ identity: "x", origin: "optimized", upstreamUrl: "", previousVersionId: "pv:b" }));
  assert.equal(view.optimized, true);
  assert.equal(view.contributionReady, false);
});

test("M6 内置工具走同一个口子出去，免得面板漏掉一半", () => {
  const view = builtinViewOf("read_file");

  assert.equal(view.source, "builtin");
  assert.equal(view.optimized, false);
  assert.equal(view.contributionReady, false);
  assert.equal(view.packageVersionId, "builtin:read_file");

  const all: readonly MyToolView[] = myToolsView([entry({ identity: "pdf-lib", origin: "direct" })], ["read_file"]);

  assert.deepEqual(
    all.map((item) => item.identity),
    ["read_file", "pdf-lib"],
  );
});

test("M7 读模型不带可写状态：视图里没有 active / lifecycle 这类可改字段", () => {
  const keys = Object.keys(viewOf(entry({ identity: "x", origin: "direct" })));
  assert.deepEqual(keys.includes("lifecycle"), false);
  assert.deepEqual(keys.includes("active"), false);
  assert.deepEqual(keys.includes("contributionBundleStatus"), false, "bundle 状态归 Board，不在这里第二份");
});

test("N1 贡献提示词是固定的：同一输入两次逐字相同，且带得出模板该有的三件事", () => {
  const context = { tool: "pdf-lib", upstreamUrl: "https://github.com/o/r", branch: "trylo/improve-pdf-lib" };
  const first = contributionPrompt(context);

  assert.equal(first, contributionPrompt(context));
  assert.equal(first.includes(context.upstreamUrl), true);
  assert.equal(first.includes(context.branch), true);
  assert.equal(first.includes(context.tool), true);
  assert.equal(first.includes(CONTRIBUTION_PLACEHOLDER), true, "改动描述必须是留给用户的占位符");
});

test("N2 模板里没有任何自动摘来的正文：没有 diff、没有轨迹、没有日志引用", () => {
  const text = contributionPrompt({ tool: "t", upstreamUrl: "https://github.com/o/r", branch: "b" });
  for (const forbidden of ["```", "diff --git", "<transcript", "<journal", "observationId"]) {
    assert.equal(text.includes(forbidden), false, `模板里不该出现 ${forbidden}`);
  }
});

test("N3 贡献助手这一层做不到「自动发布」：生产代码里没有网络、子进程与 git 调用", async () => {
  const source = await readFile(join(repoRoot, "src", "internal", "learning", "agent", "subsystems", "tool", "runtime", "contribution-prompt.ts"), "utf8");
  for (const forbidden of ["node:child_process", "node:https", "node:http", "execSync", "spawn", "fetch("]) {
    assert.equal(source.includes(forbidden), false, `贡献助手不许有 ${forbidden}`);
  }
  // 扫描器自检：真读到文件了，不是在扫一个空的路径。
  assert.equal(source.length > 200, true);
});
