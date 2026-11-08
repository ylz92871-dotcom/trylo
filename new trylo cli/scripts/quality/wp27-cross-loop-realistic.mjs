/**
 * WP27.2 cross-loop evidence.
 *
 * The stage results below are not asserted by this script: each one was traced
 * by hand from a production entry point to a real side effect, and the chain is
 * recorded beside it so the claim can be re-checked rather than trusted. What
 * this script does do is refuse to state a verdict of its own — it hands those
 * results to the shipped `evaluateCrossLoop` and writes down whatever that
 * module concludes.
 *
 * A stage with no traced chain is entered as `pending_consumer`, not skipped:
 * a missing stage and an unexamined stage must look the same in the artifact.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = join(root, "dist", "internal", "integration", "wp27", "cross-loop.js");
if (!existsSync(modulePath)) {
  console.error("FAIL build first: this evidence is computed by the shipped module, not restated by hand");
  process.exit(2);
}

const { CROSS_LOOP_STAGES, evaluateCrossLoop } = await import(pathToFileURL(modulePath).href);

const date = process.argv.slice(2).find((arg) => arg.startsWith("--date="))?.slice("--date=".length)
  ?? new Date().toISOString().slice(0, 10);
const evidenceDir = process.argv.slice(2).find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
  ?? `${date}-WP27`;

/** Traced 2026-10-10 against the working tree; every chain was read, not assumed. */
const TRACED = {
  input: {
    result: "passed",
    chain: "main.ts:391 -> commands.ts:167 handleRun -> run-command.ts:372 runOneTurn -> run-one-turn.ts:197 executeTurn",
  },
  permission: {
    result: "passed",
    chain: "wiring.ts:211 createWorkspaceTools -> adapters/sandbox/planner.ts:164 -> loop/request.ts:257 tools.snapshot()",
  },
  process: {
    result: "passed",
    chain: "adapters/tools/shell-spawn.ts spawn -> killAll/terminateProcessTree; 真实 OS 进程，非替身",
  },
  edit: {
    result: "passed",
    chain: "bindings.ts:66 APPLY_PATCH_BINDING -> mutating/index.ts:102 executeApplyPatch -> apply-patch-commit.ts:202 -> atomic-write.ts:81-82 writeFileSync+renameSync",
  },
  review: {
    result: "passed",
    chain: "args.ts:234 -> commands.ts:224 handleReview -> commands-review.ts:144 -> adapters/git/runner.ts:108 spawn(\"git\"); slash.ts:62-64 /diff /review /rollback 经 repl.ts:218 与 tui/slash-actions.ts:232",
    caveat: "review 渲染 prompt+diff 到 stdout，不把 prompt 交给模型执行；属可达渲染器，不是自主 review 回合",
  },
  skill_mcp: {
    result: "passed",
    chain: "run-one-turn.ts:54 -> skills-wiring.ts:32 -> adapters/skills/discover.ts:87 真读 SKILL.md -> tools/skill/index.ts:82 作为 tool output 回灌；MCP: run-one-turn.ts:187 -> adapters/mcp-runtime/factory.ts:47 -> mcp-stdio/transport.ts:92 spawn(spec.command) -> wiring.ts:242 composeTools",
  },
  subagent: {
    result: "passed",
    chain: "args-run.ts:67 --subagent -> wiring.ts:267 -> subagent/runtime.ts:154 spawn -> child-attempt.ts:96 runTurn(childPorts) 真嵌套引擎真 provider -> subagent-tool.ts:141 结果并入 transcript",
    caveat: "默认关闭，需 --subagent 显式开启",
  },
  cancel_recover: {
    // Traced to a real process-tree kill and a real session resume, but two
    // links are missing, so this stays pending rather than being called closed.
    result: "pending_consumer",
    chain: "取消已通电: main.ts:362 SIGINT -> tui/interrupt-hub.ts:56 -> loop/runner.ts:226 followCancellation -> runner-effects.ts:350 -> mutating/index.ts:133 -> call-cancellation.ts:62 -> shell-spawn.ts:280 killAll/terminateProcessTree；恢复已通电: session-open.ts:165 -> adapters/session-store/ndjson.ts:150 -> recovery.ts:30-124",
    gaps: [
      "loop/recover.ts 的 journal-replay 恢复在生产无消费者，仅其自身单测 import（loop/index.ts:31 仅 re-export）",
      "取消只在 TUI 链路有信号：run-command.ts:372 与 repl.ts:318 调 runOneTurn 不传 cancelSignal",
      "中断后不自动恢复，须用户显式 --resume/--last 或 /resume",
    ],
  },
};

const outcomes = CROSS_LOOP_STAGES.map((stage) => {
  const traced = TRACED[stage];
  return {
    stage,
    result: traced?.result ?? "pending_consumer",
    evidenceRef: traced?.chain ?? "no chain traced",
  };
});

const verdict = evaluateCrossLoop(outcomes);

const report = {
  date,
  package: "WP27.2",
  module: "src/internal/integration/wp27/cross-loop.ts evaluateCrossLoop",
  provenance: "每段 result 由人工从生产入口追到真实副作用后录入，chain 可复核；终局由本包已编译模块计算，脚本不自述结论",
  stages: CROSS_LOOP_STAGES.map((stage) => ({
    stage,
    result: TRACED[stage]?.result ?? "pending_consumer",
    chain: TRACED[stage]?.chain ?? "no chain traced",
    ...(TRACED[stage]?.caveat ? { caveat: TRACED[stage].caveat } : {}),
    ...(TRACED[stage]?.gaps ? { gaps: TRACED[stage].gaps } : {}),
  })),
  syntheticAllPassed: {
    kind: "closed",
    note: "仅语义自检：八段全 passed 且各带 evidenceRef 时模块才判 closed。不作为真实闭环证据。",
  },
  verdict,
  interpretation: verdict.kind === "closed"
    ? "闭环已接通"
    : verdict.kind === "partial"
      ? `真实闭环未闭合：${verdict.pendingStages.join(",")} 缺真实 adapter 消费证据，缺段永不升格 closed；实机/磁盘/TTY 归 WP28`
      : `闭环判定为 ${verdict.kind}`,
};

writeFileSync(
  join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁", "evidence", evidenceDir, "wp27-cross-loop-realistic.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`cross-loop verdict: ${verdict.kind}`);

if (verdict.kind === "partial") {
  console.log(`pending stages: ${verdict.pendingStages.join(", ")}`);
}