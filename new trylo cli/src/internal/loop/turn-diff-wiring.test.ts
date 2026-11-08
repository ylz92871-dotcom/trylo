import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionResolution } from "../ports/permission.js";
import { assembleEngine, buildTurnResult } from "./runner-engine.js";
import { toolHostFor } from "./host-views.js";
import { runToolFor } from "./tool-execution.js";
import { createFakePermission, createFakeProvider, createFakeTools, emptyProfileLoader, toolResult } from "./fakes.js";

/**
 * WP11/F1: the turn tracker is fed by the production tool funnel.
 *
 * Red evidence: `assembleEngine` created no tracker before WP11-remedy (the
 * `engine.turnDiff` access does not compile), and `runToolFor` never called
 * `noteTurnDiff` (the first assertion below fails against the un-wired
 * funnel). The path under test is the production one — engine assembled by
 * `assembleEngine`, host narrowed by `toolHostFor`, outcome executed by
 * `runToolFor`, published by `buildTurnResult` — not a reimplementation.
 */

const APPLY_PATCH_VALUE = {
  applied: [
    {
      op: "added",
      path: "fresh.ts",
      bytes: 6,
      mode: "created",
      preview: "--- /dev/null\n+++ b/fresh.ts\n@@ -0,0 +1,1 @@\n+hello\n",
    },
  ],
  exact: true,
  fileWrites: [{ kind: "file_write", path: "fresh.ts", bytes: 6, mode: "created" }],
};

async function wiredTurn(plan: Parameters<typeof createFakeTools>[0]) {
  const ports = {
    provider: createFakeProvider([]),
    tools: createFakeTools(plan),
    permission: createFakePermission("allow" as PermissionResolution),
    profile: emptyProfileLoader(),
  };
  const abort = new AbortController();
  const engine = await assembleEngine(ports, {
    sessionId: "s1",
    turnId: "t1",
    correlationId: "c1",
    text: "do it",
  }, abort);
  const host = toolHostFor(engine, ports, { dispatch: async () => undefined });

  return { engine, host, ports, abort };
}

test("a successful apply_patch feeds the engine tracker through the funnel", async () => {
  const { engine, host, ports, abort } = await wiredTurn([toolResult(APPLY_PATCH_VALUE)]);

  assert.equal(typeof host.noteTurnDiff, "function");
  await runToolFor(host, ports.tools, { toolCallId: "c1", name: "apply_patch", arguments: {} }, abort.signal);
  assert.deepEqual(engine.turnDiff.summary().files, 1);
  assert.match(engine.turnDiff.unifiedDiff() ?? "", /\+\+\+ b\/fresh\.ts/);
  const published = buildTurnResult(engine).turnDiff;

  assert.deepEqual(published.summary.files, 1);
  assert.equal(published.valid, true);
  assert.match(published.diff ?? "", /\+hello/);
});

test("failed and non-mutating outcomes leave the tracker alone", async () => {
  const { engine, host, ports, abort } = await wiredTurn([
    { outcome: "error", code: "denied", message: "no" },
    toolResult({ output: "read words" }),
  ]);

  await runToolFor(host, ports.tools, { toolCallId: "c1", name: "read_file", arguments: {} }, abort.signal);
  await runToolFor(host, ports.tools, { toolCallId: "c2", name: "read_file", arguments: {} }, abort.signal);
  assert.deepEqual(engine.turnDiff.summary().files, 0);
  assert.equal(engine.turnDiff.unifiedDiff(), undefined);
  assert.equal(buildTurnResult(engine).turnDiff.diff, undefined);
});

test("an inexact patch invalidates the turn diff with a named reason", async () => {
  const { engine, host, ports, abort } = await wiredTurn([
    toolResult({ applied: [], exact: false, fileWrites: [] }),
  ]);
  await runToolFor(host, ports.tools, { toolCallId: "c1", name: "apply_patch", arguments: {} }, abort.signal);
  assert.equal(engine.turnDiff.valid, false);
  assert.match(engine.turnDiff.invalidReason ?? "", /inexact/);
});
