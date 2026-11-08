import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "./args.js";
import type { CliContext } from "./context.js";
import { prepareRun, isRunFailure, runOneTurn } from "./run-command.js";
import { scaffoldAfterTurn } from "./turn-threading.js";
import { newTuiSessionOptions } from "./tui/slash-actions.js";
import { switchRunConnection } from "./connection-switch.js";
import { sessionLearningOptions } from "./session-learning-options.js";
import { fileWorkflowImprovementPorts } from "../../learning/agent/subsystems/workflow/adapters/improvement-composition.js";
import { searchImprovementFixture } from "../../learning/agent/subsystems/workflow/testing/improvement-fixtures.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";

test("explicit repl learning flags preserve their actual units and leave bare startup opt-in", () => {
  const parsed = parseArgs(["repl", "--learning=all", "--skill-learning-budget=9000", "--skill-learning-calls=2",
    "--workflow-learning", "--workflow-learning-budget=16000", "--collaboration-learning=off"]);

  assert.equal(parsed.kind, "repl");
  if (parsed.kind !== "repl") return;

  assert.equal(parsed.learning, "all");
  assert.equal(parsed.learningOptions?.skillLearningAllowance?.maxTokens, 9000);
  assert.equal(parsed.learningOptions?.skillLearningAllowance?.maxCalls, 2);
  assert.equal(parsed.learningOptions?.workflowLearningBudget, 16000);
  assert.equal(parsed.learningOptions?.workflowLearning, true);
  assert.deepEqual(parseArgs([]), { kind: "repl" });
});

test("two actual interactive turns, new, connection switch and resume retain one workflow purse and no closed turn port", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-interactive-learning-"));
  let ids = 0;
  const ctx: CliContext = { homeDir: root, cwd: root, env: { TRYLO_HOME: path.join(root, "home") },
    nodeVersion: "v24.0.0", stdinIsTty: false, now: () => 1793750400000, newId: prefix => `${prefix}-${++ids}`,

    readFile: file => { try { return readFileSync(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } },

    isDirectory: file => { try { return statSync(file).isDirectory(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } },

    readDir: () => [], writeFile: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return true;
    },

    stdout: () => {}, stderr: () => {}, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined };
  const sink = { stdout: ctx.stdout, stderr: ctx.stderr };

  ctx.writeFile(path.join(root, "home", "config.json"), JSON.stringify({ provider: "fixture" }));
  const initial = await prepareRun(ctx, { sink, permissionMode: "non_interactive",
    options: { message: [], readStdin: false, provider: "fixture", session: "original", learning: "method", workflowLearning: true, workflowLearningBudget: 16000 } });

  assert.ok(!isRunFailure(initial));
  if (isRunFailure(initial)) return;

  let current = initial;

  try {
    const identity = initial.workflowLearningBudgetId;
    assert.ok(identity);

    for (let turn = 0; turn < 2; turn++) {
      const outcome = await runOneTurn(ctx, current, "Continue ordinary fixture work", sink, "non_interactive", {});
      assert.ok("result" in outcome);
      if (!("result" in outcome)) return;
      const next = await scaffoldAfterTurn(current, outcome);
      assert.ok(!isRunFailure(next));
      if (isRunFailure(next)) return;
      assert.equal(next.workflowFocusedLearning, undefined, "a closed borrowed workflow port cannot enter the next scaffold");
      assert.equal(next.workflowLearningBudgetId, identity);
      current = next;
    }

    const spend = async (opportunityId: string) => {
      const seed = searchImprovementFixture(), ports = fileWorkflowImprovementPorts({ boardRoot: workflowBoardRoot(ctx),
        scope: current.workspaceId, centralScope: current.workspaceRoot, budgetId: current.workflowLearningBudgetId!, allowance: 16000, now: ctx.now });
      const funded = await ports.funding.fund({ type: "workflow_improvement_opportunity", schemaVersion: 1,
        opportunity: { ...seed.opportunity, opportunityId, task: { ...seed.opportunity.task, scope: current.workspaceId } }, evidence: seed.evidence });
      assert.ok(funded.ok);
      const reservation = await ports.funding.reserve(funded.value);
      assert.ok(reservation.ok);
      assert.ok((await ports.funding.settle(reservation.value, { kind: "reported", totalTokens: 150 })).ok);
      assert.ok((await ports.funding.finish(reservation.value, { kind: "failed", reason: "scripted_learning_abstained" })).ok);
    };

    await spend("first-purse-use");
    await current.close();
    const created = await prepareRun(ctx, { sink, permissionMode: "non_interactive", options: newTuiSessionOptions("new-session", current.learning, current) });

    assert.ok(!isRunFailure(created));
    if (isRunFailure(created)) return;
    current = created;
    assert.equal(current.workflowLearningBudgetId, identity);
    const switched = await switchRunConnection(ctx, current, { model: current.model }, sink, "non_interactive");

    assert.ok(!isRunFailure(switched));
    if (isRunFailure(switched)) return;
    current = switched;
    assert.equal(current.workflowLearningBudgetId, identity);
    const resumed = await prepareRun(ctx, { sink, permissionMode: "non_interactive", options: {
      message: [], readStdin: false, resume: "original", ...sessionLearningOptions(current) } });

    assert.ok(!isRunFailure(resumed));
    if (isRunFailure(resumed)) return;
    await current.close();
    current = resumed;
    assert.equal(current.workflowLearningBudgetId, identity);
    await spend("next-purse-use");
    const board = await createBoardReader(workflowBoardRoot(ctx)).load();
    assert.ok(board.ok);
    assert.deepEqual(board.state.centralLearningGrants?.filter(grant => grant.domain === "workflow").map(grant => grant.allowance.maxTokens), [16000, 15850]);
  } finally {
    await current.close();
    rmSync(root, { recursive: true, force: true });
  }
});
