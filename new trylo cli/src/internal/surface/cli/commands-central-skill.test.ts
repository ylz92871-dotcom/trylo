import assert from "node:assert/strict";
import test from "node:test";
import { handleCentralSkill } from "./commands-central-skill.js";
import type { CliContext } from "./context.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";

test("an explicit skill request validates original user text before opening source or model hosts", async () => {
  for (const learnRequest of [null, {}, 7, "", "   ", "x".repeat(65537), "\ud800"]) {
    const output: string[] = [];
    const unavailable = (): never => { throw new Error("invalid_request_must_not_open_a_host"); };
    const ctx: CliContext = { cwd: "D:/workspace", homeDir: "D:/profile", env: {}, nodeVersion: "v24", stdinIsTty: false,
      readFile: unavailable, isDirectory: unavailable, readDir: unavailable, writeFile: unavailable,
      readStdin: unavailable, readLine: unavailable, readSecret: unavailable,
      stdout: value => output.push(value), stderr: unavailable, now: unavailable, newId: unavailable };

    assert.equal(await handleCentralSkill(ctx, { workspaceRoot: "D:/workspace", sessionId: "actual-session", learnRequest,
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 4000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } }), EXIT_CODES.USAGE);
    assert.equal(output.length, 1);
    assert.equal(JSON.parse(output[0]!).reason, "central_skill_input_invalid");
  }
});
