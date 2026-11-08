import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";
import { createFakePermission } from "../../loop/fakes.js";
import { literalFileCommand } from "./literal-file-command.js";
import { fileCommandWiring } from "./file-command-provider.js";
import { wirePorts } from "./wiring.js";
import { budgetOf, runRecordedTurn } from "./turn-execution.js";

const baseline = process.env["WPCL_FILE_BASELINE_DIST"];
const execute: typeof executeTurn = baseline === undefined ? executeTurn
  : (await import(pathToFileURL(path.join(baseline, "internal/surface/cli/host.js")).href)).executeTurn;

async function scenario(body: (root: string, input: TurnHostInput) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-literal-file-")), workspace = path.join(root, "workspace");

  mkdirSync(workspace);

  try {
    await body(root, { text: "", sessionId: "s", turnId: "t", correlationId: "c", workspaceRoot: workspace,
      workspaceId: "w", checkpointRoot: path.join(root, "undo"), providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
      permission: createFakePermission("approved"), format: "stream-json", now: () => 100,
      sink: { stdout: () => undefined, stderr: () => undefined },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const file of ["MEMORY.md", "OTHER.txt", "nested/中文.txt"]) for (const enabled of [false, true]) {
  test(`literal file has actual write/read evidence (${file}, learning=${enabled})`, () => scenario(async (root, input) => {
    const result = await execute({ ...input, text: `请生成 ${file} 文件，内容只有“这是普通项目文档”，不要存用户记忆。`,
      ...(enabled ? { userLearning: { homeDir: root, env: { TRYLO_HOME: root }, workspaceId: "w", now: () => 100, warn: () => undefined } } : {}),
    });

    assert.equal(isTurnFailure(result), false);

    if (isTurnFailure(result)) return;

    assert.equal(result.result.status, "completed");
    assert.match(result.result.lastMessage, /已读回核对字面内容/);
    assert.equal(readFileSync(path.join(input.workspaceRoot, file), "utf8"), "这是普通项目文档");
    assert.equal(existsSync(path.join(root, "learning/user/facts.ndjson")), false);
    assert.equal(result.result.usage.totalTokens, 0);
  }));
}

test("a denied literal file write has no success claim or file", () => scenario(async (_root, input) => {
  const result = await execute({ ...input, text: '请创建 deny.txt 文件，内容为“data”。', permission: createFakePermission("denied") });
  assert.equal(isTurnFailure(result), false);
  if (isTurnFailure(result)) return;
  assert.notEqual(result.result.status, "completed");
  assert.doesNotMatch(result.result.lastMessage, /已写入项目文件|已读回/);
  assert.equal(existsSync(path.join(input.workspaceRoot, "deny.txt")), false);
}));

test("report-only budget after writing truthfully distinguishes an unverified write", () => scenario(async (_root, input) => {
  const result = await execute({ ...input, text: '请创建 budget.txt 文件，内容为“data”。', maxIterations: 2 });
  assert.equal(isTurnFailure(result), false);
  if (isTurnFailure(result)) return;
  assert.notEqual(result.result.status, "completed");
  assert.match(result.result.lastMessage, /已写入.*尚未通过读回核验/);
  assert.equal(readFileSync(path.join(input.workspaceRoot, "budget.txt"), "utf8"), "data");
}));

test("one request cannot confirm a write and therefore starts no side effect", () => scenario(async (_root, input) => {
  const result = await execute({ ...input, text: '请创建 short.txt 文件，内容为“data”。', maxIterations: 1 });
  assert.equal(isTurnFailure(result), false);
  if (isTurnFailure(result)) return;
  assert.notEqual(result.result.status, "completed");
  assert.match(result.result.lastMessage, /尚未写入/);
  assert.equal(existsSync(path.join(input.workspaceRoot, "short.txt")), false);
}));

for (const read of ["error", "mismatch", "truncated"] as const) {
  test(`readback ${read} cannot become verified delivery`, () => scenario(async (_root, initial) => {
    const input = { ...initial, text: '请创建 proof.txt 文件，内容为“data”。' };
    const base = wirePorts({ providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
      workspaceRoot: input.workspaceRoot, permission: input.permission });
    if ("code" in base) throw new Error(base.detail);

    const tools = base.ports.tools;
    const wiring = fileCommandWiring({ ...base, ports: { ...base.ports, tools: { ...tools, async execute(call, signal) {
      if (call.name !== "read_file") return tools.execute(call, signal);
      return read === "error" ? { outcome: "error" as const, code: "injected_read_error", message: "unavailable" }
        : { outcome: "result" as const, value: { path: "proof.txt", content: read === "mismatch" ? "other" : "data" }, output: "data", truncated: read === "truncated" };
    } } } }, input);
    if ("code" in wiring) throw new Error(wiring.detail);

    try {
      const result = await runRecordedTurn(wiring.ports, input, budgetOf(input), undefined, () => undefined);
      assert.equal(result.state.terminalReason, "failed");
      assert.match(result.transcript.filter(item => item.kind === "assistant_text").map(item => item.text).join("\n"), /已写入.*尚未通过读回核验/);
      assert.equal(readFileSync(path.join(input.workspaceRoot, "proof.txt"), "utf8"), "data");
    } finally { await wiring.close(); }
  }));
}

test("only a complete single safe path with literal content becomes a command", () => {
  for (const file of ["../outside.txt", "/absolute.txt", "C:/drive.txt", "folder/../outside.txt", "NUL.txt", "aux/x", "COM¹.txt", "folder./x", "//server/share", "a\\b.txt"]) {
    assert.equal(literalFileCommand(`请创建 ${file} 文件，内容为“data”。`), undefined, file);
  }

  for (const text of ['如果可以，请创建 a.txt 文件，内容为“data”。', '请创建 a.txt 文件，内容为“data”，然后运行代码。', '“请创建 a.txt 文件，内容为 data”', '```请创建 a.txt 文件，内容为“data”。```', '请创建 a.txt 和 b.txt 文件，内容为“data”。']) {
    assert.equal(literalFileCommand(text), undefined, text);
  }

  assert.deepEqual(literalFileCommand('请创建 literal.txt 文件，内容为“然后运行代码”'), { path: "literal.txt", content: "然后运行代码" });
});
