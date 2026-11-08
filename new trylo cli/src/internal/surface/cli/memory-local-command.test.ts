import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";
import { createFakePermission } from "../../loop/fakes.js";
import { createFileFactStore } from "../../integration/user-learning/facts-file.js";
import { buildPermissionAction, createPermissionGrantCache } from "../../loop/permission-grants.js";

for (const decision of ["approved", "denied", "standing-denied"] as const) for (const enabled of [true, false]) for (const command of [
  "我是 YL Z，Trylo 的开发者，请记住",
  "请先检索现有正式记忆，再记住：我是 YL Z，Trylo 的开发者。请报告实际保存结果。",
]) test(`a memory-only user command has a truthful result (decision=${decision}, enabled=${enabled}, command=${command})`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-command-")), workspace = path.join(root, "workspace");
  const { mkdirSync } = await import("node:fs");

  mkdirSync(workspace);

  try {
    const output: string[] = [];
    const permission = createFakePermission(decision === "denied" ? "denied" : "approved");
    const grants = createPermissionGrantCache();

    if (decision === "standing-denied") grants.record(buildPermissionAction("prior", "memory_remember", {}), "denied", "session");

    let requests = 0;
    const input: TurnHostInput = {
      text: command, sessionId: "s", turnId: "t", correlationId: "c",
      workspaceRoot: workspace, workspaceId: "ws", checkpointRoot: path.join(root, "undo"),
      providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
      grants, permission: { ...permission, request(action) {
        requests += 1;
        return permission.request(action);
      } }, format: "stream-json", now: () => 100,
      sink: { stdout: (line) => output.push(line), stderr: () => undefined },
      ...(enabled ? { userLearning: { homeDir: root, env: { TRYLO_HOME: root }, workspaceId: "ws", now: () => 100, warn: () => undefined } } : {}),
    };
    const outcome = await executeTurn(input);

    assert.equal(isTurnFailure(outcome), false);

    if (isTurnFailure(outcome)) return;

    const saved = enabled && decision === "approved";

    assert.match(outcome.result.lastMessage, saved ? /已保存到 Trylo 用户记忆/ : enabled ? /未完成|失败|未保存/u : /未保存.*未开启/u);
    const file = path.join(root, "learning", "user");

    assert.equal(existsSync(path.join(file, "facts.ndjson")), saved);

    if (saved) {
      const facts = createFileFactStore(file).read();

      assert.equal(facts.ok && facts.records.length, 1);

      for (const [index, question] of [
        "你知道我是谁吗？",
        "你是不是我开发的？请先查正式记忆，分别回答 Trylo 产品和基础模型。",
        "你觉得你是谁开发的，是不是我呢？",
        "你是谁开发的，是不是我？",
        "你是不是我开发的？请区分 Trylo 产品和基础模型。",
        "你是谁开发的，是不是我？请区分 Trylo 产品和基础模型。",
        "你觉得你是谁开发的，是不是我呢？请区分 Trylo 产品和基础模型。",
      ].entries()) {
        const reply = await executeTurn({ ...input, text: question, turnId: `query-${index}` });
        assert.equal(isTurnFailure(reply), false);
        if (isTurnFailure(reply)) continue;
        assert.match(reply.result.lastMessage, /YL Z/u);
        assert.doesNotMatch(reply.result.lastMessage, /record_id:|expected_version:/u);
        if (index >= 1) assert.match(reply.result.lastMessage, /基础模型.*(?:不能|无法)/u);
      }
    }

    assert.deepEqual(readdirSync(workspace), []);
    assert.equal(requests, enabled && decision !== "standing-denied" ? 1 : 0);
    assert.equal(output.filter((line) => line.includes('"type":"run_result"')).length, saved ? 8 : 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
