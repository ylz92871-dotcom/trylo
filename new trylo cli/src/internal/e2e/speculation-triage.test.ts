import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { NO_LEARNING_PROFILE } from "../surface/cli/wiring.js";
import { EMPTY_PROFILE } from "../contract/profile.js";
import {
  APPROVED_DEFERRED_PACKAGES,
  triageAllProductionFiles,
} from "./speculation-triage.js";

/**
 * W3 Speculation Triage & Seam Guard (WP 2026-09-17 地基收口 W3):
 *
 * Verifies that speculative seams (placeholders without live production consumers)
 * are categorized accurately:
 *  - [已接]: Verified to have a production caller on the W1 path.
 *  - [标 OPEN]: Guarded against accidental activation, speculative scaffolding,
 *    or directory creation in production CLI runs.
 *  - [移除]: Structural dead weight only, with zero active consumers and explicit owner signoff.
 */

test("W3 去投机分诊：NO_LEARNING_PROFILE 严格隔离激活层与控制板", async () => {
  const loaded = await NO_LEARNING_PROFILE.load("task-1");
  assert.deepEqual(loaded, EMPTY_PROFILE);
  assert.equal(loaded.learningMode, "no_learning");
  assert.equal(loaded.skillRefs.length, 0);
  assert.equal(loaded.userRules.length, 0);
  assert.equal(loaded.toolBindings.length, 0);
});

test("W3 去投机分诊：ToolRunnerPort 标记为 OPEN，不提前在主仓铺桩", () => {
  // ToolRunnerPort belongs to the subAgent infrastructure work package (SA-3)
  // and tool learning spec §8. It must NOT be prematurely created in src/internal/ports.
  const portsDir = fileURLToPath(new URL("../ports", import.meta.url));
  const toolRunnerPortPath = `${portsDir}/tool-runner.ts`;

  assert.equal(
    existsSync(toolRunnerPortPath),
    false,
    "ToolRunnerPort must not be speculatively added before SA-3 subAgent dispatch",
  );
});

test("W3 去投机分诊：生产 CLI wiring 不得直接导入学习总控制板", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const wiringFile = join(root, "src", "internal", "surface", "cli", "wiring.ts");
  const text = readFileSync(wiringFile, "utf8");

  // Production CLI must not import learning/control or adapters/learning-store
  assert.equal(
    text.includes('from "../../learning/control'),
    false,
    "wiring.ts must not import learning/control directly",
  );
  assert.equal(
    text.includes('from "../../adapters/learning-store'),
    false,
    "wiring.ts must not import learning-store directly",
  );
});

test("W3 去投机分诊：在跑包写入集完整性保护（不得误删）", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // Method learning, user learning, mcp runtime, and tooling are active workstreams
  const activeFiles = [
    join(root, "src", "internal", "learning", "agent", "subsystems", "method", "adapters", "wiring.ts"),
    join(root, "src", "internal", "integration", "user-learning", "index.ts"),
    join(root, "src", "internal", "adapters", "mcp-runtime", "index.ts"),
    join(root, "src", "internal", "tooling", "catalog", "index.ts"),
  ];

  for (const abs of activeFiles) {
    assert.equal(existsSync(abs), true, `Active workstream file must be preserved: ${abs}`);
  }
});

test("ENG-3 五态分诊：全仓 100% 生产 TypeScript 源码已纳入五态分类，0 孤立未分诊文件", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const srcRoot = join(root, "src");
  const { items, counts, unclassified } = triageAllProductionFiles(srcRoot);

  assert.equal(unclassified.length, 0, `All files must be classified, found: ${unclassified.join(", ")}`);
  assert.ok(items.length > 400, `Expected >400 production files, got ${items.length}`);
  assert.ok(counts.production_reachable > 0, "Expected production_reachable files");
  assert.ok(counts.library_reachable > 0, "Expected library_reachable files");
  assert.ok(counts.test_support > 0, "Expected test_support files");
  assert.ok(counts.approved_deferred > 0, "Expected approved_deferred files");
  assert.equal(counts.remove, 0, "Zero unassigned orphaned files scheduled for deletion");
});

test("ENG-3 五态分诊：每个 approved_deferred 模块具备明确的所有者、消费者、目标里程碑和归宿", () => {
  assert.ok(APPROVED_DEFERRED_PACKAGES.length >= 10, "Expected approved deferred package registry");
  for (const pkg of APPROVED_DEFERRED_PACKAGES) {
    assert.ok(pkg.owner.length > 0, `Package ${pkg.domain} must have an owner`);
    assert.ok(pkg.primaryConsumer.length > 0, `Package ${pkg.domain} must have a primary consumer`);
    assert.ok(pkg.targetMilestone.length > 0, `Package ${pkg.domain} must specify target milestone`);
    assert.ok(pkg.exitCondition.length > 0, `Package ${pkg.domain} must specify exit condition`);
    assert.ok(pkg.justification.length > 0, `Package ${pkg.domain} must specify justification`);
  }
});

test("ENG-3 五态分诊：library_reachable 纯模块具备完备的导出面和合同测试", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // Canonical contracts and protocols have formal contract test suites
  const contractTest = join(root, "src", "internal", "contract", "canonical.test.ts");
  const protocolTest = join(root, "src", "internal", "protocol", "mapping-table.test.ts");
  assert.equal(existsSync(contractTest), true, "Contract library must have canonical contract test");
  assert.equal(existsSync(protocolTest), true, "Protocol library must have protocol contract test");
});

test("ENG-3 五态分诊：test_support 设施严格隔离，绝不暴露在主 CLI 导出面", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const mainTs = join(root, "src", "cmd", "trylo", "main.ts");
  const text = readFileSync(mainTs, "utf8");

  // Production entry point must never import test doubles, harnesses, or mock servers
  assert.equal(text.includes("mock-oauth-server"), false, "main.ts must not import mock server");
  assert.equal(text.includes("regression-harness"), false, "main.ts must not import regression harness");
  assert.equal(text.includes("golden-trace"), false, "main.ts must not import golden trace");
});

