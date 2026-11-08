import assert from "node:assert/strict";
import test from "node:test";
import type { CliContext } from "./context.js";
import { openToolEvolutionSession } from "./tool-evolution-session.js";
import { ToolLearningServiceError } from "../../learning/agent/subsystems/tool/domain/evolution/service-error.js";

test("closing a tool session is idempotent and refuses a later model request before dispatch", async () => {
  const ctx: CliContext = { env: {}, homeDir: "unused-profile", cwd: "unused-workspace", nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => false, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `test-${prefix}` };
  // The offline fixture provides constructor configuration only; close must
  // reject before any worker/provider dispatch, with no execution or Board IO.
  const session = openToolEvolutionSession(ctx, { provider: "fixture", message: [], readStdin: false }, { boardRoot: "unused-board" });

  assert.ok(!("exitCode" in session));
  const first = session.close(), second = session.close();
  assert.equal(first, second);
  await first;
  await assert.rejects(async () => session.complete("This request must never dispatch", new AbortController().signal, "contract"),
    error => error instanceof ToolLearningServiceError && error.code === "tool_session_closed");
  await session.retireWorkers();
});
