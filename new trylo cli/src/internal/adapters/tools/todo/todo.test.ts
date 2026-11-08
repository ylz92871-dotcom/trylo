import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTodoTools } from "./index.js";
import { createWorkspaceTools } from "../index.js";
import type { ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import type { JsonObject } from "../../../protocol/envelope.js";

/**
 * `todo_write`：模型的自管任务清单。
 *
 * 行为对标旧 CLI 的 TodoWrite：**整张表替换**，不是增量编辑——模型每次交出它此刻
 * 认为完整的事实，清单因此永远自洽，不存在「update 打到一条已不存在的条目」这种
 * 状态。三条本地合同：
 *
 *  - 表活在**这次装配**的闭包里：不碰工作区、不碰盘，sideEffect 因此是
 *    `read_only`、免审批（R1 的诚实版本：确实没有任何外部效应）；跨轮次找回
 *    靠会话日志里上一次调用的回声，不是靠隐藏的存储；
 *  - 校验在入口：状态闭集、内容非空、条数封顶。坏参数是 `invalid_arguments`
 *    错误，绝不部分替换——半张新表盖住半张旧表是最难查的清单腐败；
 *  - 回声即证据：结果文本带复选框渲染与计数，让模型（和读日志的人）无需再
 *    「读」一次就能看到清单现在长什么样。
 */

function call(toolCallId: string, args: JsonObject): ToolCallRequest {
  return { toolCallId, name: "todo_write", arguments: args };
}

async function write(port: ToolPort, args: JsonObject) {
  return port.execute(call("todo-1", args), new AbortController().signal);
}

function asResult(outcome: ToolOutcome & { outcome?: string }) {
  assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
  return outcome as { outcome: "result"; value: Record<string, unknown>; output: string };
}

test("the binding is a read-only, approval-free replace-the-list tool", () => {
  const port = createTodoTools();
  const binding = port.snapshot().find((entry) => entry.name === "todo_write");
  assert.ok(binding !== undefined);
  assert.equal(binding.sideEffect, "read_only");
  assert.equal(binding.needsApproval, false);
});

test("todo_write rides the workspace catalog too, so a real run can see it", () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-todo-catalog-"));
  try {
    writeFileSync(join(root, "package.json"), "{}");
    const names = createWorkspaceTools({ workspaceRoot: root }).snapshot().map((b) => b.name);
    assert.ok(names.includes("todo_write"), `catalog names: ${names.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid list is stored, echoed with checkboxes and counts, and replaced whole", async () => {
  const port = createTodoTools();
  const first = asResult(
    await write(port, {
      todos: [
        { content: "plan the fix", status: "completed" },
        { content: "write the test", status: "in_progress", activeForm: "writing the test" },
        { content: "run verify", status: "pending" },
      ],
    }),
  );

  assert.match(first.output, /\[x\] plan the fix/);
  assert.match(first.output, /\[~\] writing the test/);
  assert.match(first.output, /\[ \] run verify/);
  assert.deepEqual(first.value["counts"], { total: 3, completed: 1, inProgress: 1, pending: 1 });

  // Replacement, not merge: the second call's echo contains only its own rows.
  const second = asResult(
    await write(port, { todos: [{ content: "ship it", status: "pending" }] }),
  );

  assert.equal(second.output.includes("write the test"), false);
  assert.match(second.output, /\[ \] ship it/);
});

test("an empty list is a legal clear, echoed as such", async () => {
  const port = createTodoTools();
  await write(port, { todos: [{ content: "a", status: "pending" }] });
  const cleared = asResult(await write(port, { todos: [] }));
  assert.deepEqual(cleared.value["counts"], { total: 0, completed: 0, inProgress: 0, pending: 0 });
});

test("bad arguments refuse the call and keep the previous list intact", async () => {
  const port = createTodoTools();
  const good = await write(port, { todos: [{ content: "keep me", status: "pending" }] });

  assert.equal(good.outcome, "result");

  const refusals: ReadonlyArray<JsonObject> = [
    { todos: [{ content: "x", status: "almost_done" }] }, // 闭集外的状态
    { todos: [{ content: "  ", status: "pending" }] }, // 空白内容
    { todos: [{ status: "pending" }] }, // 缺 content
    { todos: "not-a-list" }, // 类型错
    {}, // 缺 todos
    { todos: Array.from({ length: 51 }, (_unused, i) => ({ content: `t${i}`, status: "pending" })) }, // 超上限
  ];

  for (const args of refusals) {
    const bad = await write(port, args);
    assert.equal(bad.outcome, "error", JSON.stringify(args));
    const error = bad as { outcome: "error"; code: string };
    assert.equal(error.code, "invalid_arguments", JSON.stringify(args));
  }

  // 校验先于替换：被拒的调用没碰过存储——下一次成功调用回声的 previousTotal
  // 仍是第一笔合法写入的那 1 条。
  const echo = asResult(await write(port, { todos: [{ content: "keep me", status: "pending" }] }));

  assert.equal(echo.value["previousTotal"], 1, "refused calls must not touch the stored list");
});

test("an unknown tool name on the todo port is unknown, never a silent no-op", async () => {
  const port = createTodoTools();
  const outcome = await port.execute(
    { toolCallId: "x", name: "todo_unknown", arguments: {} },
    new AbortController().signal,
  );
  assert.equal(outcome.outcome, "unknown");
});
