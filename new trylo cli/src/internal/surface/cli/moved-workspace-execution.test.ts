import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { testScratchPath } from "../../testing/scratch.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { WRITE_FIXTURE_CONTENT, WRITE_FIXTURE_PATH } from "../../adapters/provider/fixture.js";
import { isRuntimeFingerprint } from "../../ports/session.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { isRunFailure, prepareRun, runOneTurn } from "./run-command.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";
import { workspaceIdentity } from "./workspace-identity.js";

test("trusted moved workspace executes physical files while session and charged root keep their original identity", async t => {
  const scratch = testScratchPath("moved-workspace-execution");

  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "run-"));

  t.after(() => {
    assert.equal(path.dirname(root), scratch);
    rmSync(root, { recursive: true, force: true });
  });
  const logical = path.join(root, "former-location"), physical = path.join(root, "moved-location");
  const home = path.join(root, "profile"), foreign = path.join(root, "foreign");

  for (const directory of [physical, home, foreign]) mkdirSync(directory);

  // Explicit maintenance evidence, equivalent to the approved relocation table.
  // Production resolution itself receives no additional alias or relaxed rule.
  const physicalDataPath = (file: string) => file === logical || file.startsWith(logical + path.sep)
    ? physical + file.slice(logical.length) : file;
  const issuedAt = "2026-11-08T00:00:00.000Z";
  let nextId = 0;
  const ctx: CliContext = { homeDir: root, cwd: logical, env: { TRYLO_HOME: home }, nodeVersion: "test", platform: "win32",
    stdinIsTty: false, readFile: file => existsSync(physicalDataPath(file)) ? readFileSync(physicalDataPath(file), "utf8") : undefined,
    isDirectory: file => existsSync(physicalDataPath(file)) && statSync(physicalDataPath(file)).isDirectory(),
    realPath: file => existsSync(physicalDataPath(file)) ? realpathSync.native(physicalDataPath(file)) : undefined,
    readDir: () => [], writeFile: () => false, readStdin: async () => "", readLine: async () => undefined,
    readSecret: async () => undefined, stdout: () => {}, stderr: () => {}, now: () => Date.parse(issuedAt), newId: prefix => `${prefix}-${++nextId}` };
  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env);
  const loaded = await withBoardWriter(boardRoot, async store => {
    const opened = await store.apply({ type: "coordinate_learning", commandId: "moved:open", issuedAt,
      action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "budget:moved", scope: logical,
        unit: "total_model_tokens", limits: { tokens: 1000, calls: 10, steps: 10 }, authorizationRef: "authorization:moved" } } });

    assert.ok(opened.ok);

    return store.apply({ type: "coordinate_learning", commandId: "moved:unknown-reservation", issuedAt,
      action: { kind: "reserve_budget_usage", budgetId: "budget:moved", scope: logical, expectedSequence: 1,
        owner: { kind: "central_deliberation", ownerId: "original" }, reservationId: "original:pending", maxTokens: 200 } });
  });

  assert.ok(loaded.ok);
  const rootRef = { budgetId: "budget:moved", scope: logical, openedSequence: 1, authorizationRef: "authorization:moved" };
  const saveIntent = (scope: string) => {
    const owner = tryAcquireRuntimeOwner(runtimeScopePaths(home, logical));
    assert.ok(owner.ok);

    try { assert.ok(owner.value.writeIntent({ schemaVersion: 1, homeRoot: home, workspaceRoot: logical, enabled: false,
      wakeSequence: 1, consumedSequence: 0, wakeReason: "controlled_fixture", sourceRefs: [], configuration: {
        schemaVersion: 1, providerId: "fixture-write", model: "fixture", endpointHash: "fixture", userLearning: false,
        workspaceId: workspaceIdentity(logical), rootRef: { ...rootRef, scope },
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 10, maxSteps: 10, maxPromptChars: 5000 } } }).ok); }
    finally { owner.value.close(); }
  };

  saveIntent(logical);
  const originalBoard = await createBoardReader(boardRoot).load();
  assert.ok(originalBoard.ok);
  const resolved = await resolveCentralRuntimeWorkspaceIdentity(ctx, logical, { allowBudgetLookup: true });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.workspaceRoot, logical);
  assert.equal(resolved.value.physicalRoot, realpathSync.native(physical));
  const run = await prepareRun(ctx, { options: { message: [], readStdin: false, session: "moved-business", provider: "fixture-write",
    allowWrites: true, shellIsolation: "host", toolSelection: ["read_file", "write_file"] }, sink: ctx, permissionMode: "non_interactive" });

  assert.ok(!isRunFailure(run), JSON.stringify(run));
  if (isRunFailure(run)) return;

  try {
    // A stopped learning runtime preserves its identity without acquiring a background owner.
    const result = await runOneTurn(ctx, run, "Write the fixture artifact and read it back.", ctx,
      "non_interactive", { allowWrites: true });

    assert.ok("result" in result, JSON.stringify(result));
    assert.equal(result.result.status, "completed");
    assert.equal(readFileSync(path.join(physical, WRITE_FIXTURE_PATH), "utf8"), WRITE_FIXTURE_CONTENT);
    assert.equal(existsSync(logical), false, "no old directory or hidden filesystem alias was created");
    assert.equal(Reflect.get(run.execution!, "workspaceRoot"), realpathSync.native(physical));
    assert.equal(run.workspaceRoot, logical);
    assert.equal(run.workspaceId, workspaceIdentity(logical));
    assert.deepEqual(run.workspaceIdentity?.rootRef, rootRef);
    assert.ok(run.session);
    const records = await run.session.readRecords();
    assert.ok(records.ok);
    const fingerprint = records.view.records[0]?.payload.fingerprint;
    assert.ok(isRuntimeFingerprint(fingerprint));
    assert.equal(fingerprint.workspaceRoot, logical);
    assert.equal(fingerprint.workspaceId, workspaceIdentity(logical));
  } finally {
    await run.close();
    await run.execution?.close();
  }

  const { realPath: _witness, ...unwitnessed } = ctx;
  const rejected = await resolveCentralRuntimeWorkspaceIdentity({ ...unwitnessed, cwd: physical }, physical,
    { allowBudgetLookup: true, resumeSessionId: "moved-business" });

  assert.equal(rejected.ok, false, "a physical migration cannot be inferred from a saved scope alone");
  saveIntent(foreign);
  const foreignResult = await resolveCentralRuntimeWorkspaceIdentity(ctx, logical, { allowBudgetLookup: true });

  assert.ok(!foreignResult.ok);
  assert.equal(foreignResult.reason, "runtime_workspace_root_mismatch");
  const after = await createBoardReader(boardRoot).load();
  assert.ok(after.ok);
  assert.deepEqual(after.state, originalBoard.state, "ordinary execution neither reopens nor refunds the original reserved funds");
});
