import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { parseArgs } from "./args.js";
import type { CliContext } from "./context.js";
import { handleRun, prepareRun } from "./run-command.js";

test("one-shot resume records the actual user's answer through the restored question owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-question-resume-"));
  let id = 0;
  const ctx: CliContext = {
    env: { TRYLO_HOME: root }, homeDir: root, cwd: root, nodeVersion: process.version, stdinIsTty: false,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory: () => true, readDir: () => [], writeFile: () => true,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `${prefix}-${++id}`,
  };

  try {
    const initial = parseArgs(["run", "--provider", "fixture", "--session", "question-resume", "hello"]);
    if (initial.kind !== "run") throw new Error("bad test arguments");

    const scaffold = await prepareRun(ctx, { options: initial.options, sink: ctx, permissionMode: "non_interactive" });
    if ("exitCode" in scaffold) throw new Error(scaffold.message);

    try {
      assert(scaffold.questions && scaffold.session);
      const argumentsValue = { questions: [{ id: "color", header: "颜色", question: "选择颜色？", options: [{ label: "蓝色", description: "蓝" }, { label: "红色", description: "红" }] }] };
      const asked = await scaffold.questions.execute({ name: "ask_user_question", toolCallId: "ask", arguments: argumentsValue }, new AbortController().signal);
      if (asked.outcome !== "result") throw new Error("ask refused");

      for (const payload of [
        { kind: "tool_call", sequence: 0, toolCallId: "ask", name: "ask_user_question", arguments: argumentsValue },
        { kind: "tool_result", sequence: 1, toolCallId: "ask", name: "ask_user_question", outcome: "succeeded", output: asked.output, truncated: false },
      ]) assert.equal((await scaffold.session.append({ type: "transcript_item", sessionId: scaffold.sessionId, turnId: "ask-turn", at: "1970-01-01T00:00:00Z", payload })).ok, true);
    } finally { await scaffold.close?.(); }

    const resumed = parseArgs(["run", "--provider", "fixture", "--resume", "question-resume", "蓝色"]);
    if (resumed.kind !== "run") throw new Error("bad resume arguments");

    assert.equal(await handleRun(ctx, resumed.options, ctx), 0);
    const store = createNdjsonSessionStore({ path: join(root, "sessions", "question-resume.ndjson") });
    const recovered = await store.read();

    assert(recovered.ok);

    if (!recovered.ok) throw new Error("read refused");

    assert(recovered.session.transcript.some(item => item.kind === "user" && /^User answer for request .*: \{"color":"蓝色"\}/.test(item.text)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
