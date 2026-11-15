import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { testScratchPath } from "../../testing/scratch.js";
import type { CliContext } from "./context.js";
import { handleRun } from "./run-command.js";

test("invalid optional media configuration does not block an ordinary CLI task", async () => {
  const root = mkdtempSync(testScratchPath("optional-media-"));
  const out: string[] = [], err: string[] = [];
  const ctx: CliContext = {
    env: { TRYLO_MEDIA_CONFIG: "invalid-json" }, homeDir: root, cwd: root, nodeVersion: "v22.0.0", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: () => [], writeFile: () => true,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => out.push(text), stderr: text => err.push(text), now: () => 0, newId: prefix => `${prefix}-1`,
  };
  const code = await handleRun(ctx, { provider: "fixture", format: "stream-json", message: ["Reply to this ordinary text request."], readStdin: false },
    { stdout: text => out.push(text), stderr: text => err.push(text) });
  assert.equal(code, 0, err.join(""));
  const frames = out.flatMap(text => text.trim().split("\n")).filter(Boolean).map(line => JSON.parse(line));
  assert.ok(frames.some(frame => frame.type === "run_result" && frame.status === "completed"));
  assert.match(err.join(""), /image\/video.*configuration/i);
});
