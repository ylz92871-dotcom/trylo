import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { CliContext } from "./context.js";
import { handleCheckLearning, runCheckLearningOperation } from "./commands-check-learning.js";
import { requirementDigest } from "../../learning/check/v2/parse.js";

const SIGNAL = new AbortController().signal;

function fixture(t: { after(run: () => void): void }) {
  const base = testScratchPath("check-learning-v2-cli-contracts");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-")), profile = path.join(root, "profile");

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output: string[] = [];
  let configReads = 0, observed = 0, detached = 0;
  const unexpected = (): never => { throw new Error("management touched task/provider IO"); };
  const ctx: CliContext = { env: { TRYLO_HOME: profile }, homeDir: path.join(root, "unused"), cwd: root, nodeVersion: process.version,
    stdinIsTty: false, readFile: () => {
      configReads += 1;
      return unexpected();
    }, readDir: unexpected,
    writeFile: unexpected, isDirectory: unexpected, readStdin: unexpected, readLine: unexpected, readSecret: unexpected,
    stdout: text => output.push(text), stderr: unexpected, now: () => 1793651000000, newId: unexpected,
    interrupts: { observe: () => { observed += 1; }, unobserve: () => { detached += 1; }, exit: unexpected } };

  return { root, profile, ctx, output, counts: () => ({ configReads, observed, detached }) };
}

test("zero allowance and read-only management invoke no model, credentials or task executor", async t => {
  const fx = fixture(t);
  const zero = await handleCheckLearning(fx.ctx, { subsystem: "check", action: "learn", allowance: { modelCalls: 0, tokens: 0, executions: 0 } });

  assert.equal(zero, 0);
  assert.equal(JSON.parse(fx.output.at(-1)!).stop, "zero_allowance");
  assert.equal(existsSync(fx.profile), false);
  assert.equal(await handleCheckLearning(fx.ctx, { subsystem: "check", action: "status" }), 0);
  assert.deepEqual(JSON.parse(fx.output.at(-1)!).counts, { experiences: 0, versions: 0, runs: 0, feedbacks: 0, jobs: 0 });
  assert.equal(await handleCheckLearning(fx.ctx, { subsystem: "check", action: "recover" }), 0);
  assert.equal(existsSync(fx.profile), false, "management does not create an empty store");
  assert.deepEqual(fx.counts(), { configReads: 0, observed: 3, detached: 3 });
});

test("capture and status share the actual profile Board with idempotent attributed facts", async t => {
  const fx = fixture(t);
  const basis = { text: "The total must be a number.", schema: { type: "object", properties: { total: { type: "number" } }, required: ["total"] } };
  const digest = requirementDigest(basis);
  const value = { schemaVersion: 2, type: "check_experience", id: "experience:actual-output", scope: "project:invoice",
    sessionId: "session:one", turnId: "turn:one", requirements: { ...basis, ref: "requirement:total", digest },
    facts: { task: { instruction: "Produce an invoice.", requirementRef: "requirement:total", requirementDigest: digest },
      phase: "before_completion", output: { total: "wrong" } }, priorRuns: [],
    assessment: { kind: "task_oracle", verdict: "invalid", sourceRef: "oracle:schema-real-failure" } };
  const first = await runCheckLearningOperation(fx.ctx, { action: "capture", value }, SIGNAL);

  assert.equal(first.exitCode, 0, JSON.stringify(first));
  const again = await runCheckLearningOperation(fx.ctx, { action: "capture", value }, SIGNAL);

  assert.equal(again.exitCode, 0);
  const log = path.join(fx.profile, "learning", "board", "board-events.ndjson");
  const committed = readFileSync(log, "utf8");

  assert.ok(committed.includes("experience:actual-output"));
  assert.ok(committed.includes("verifier"));
  assert.equal(await handleCheckLearning(fx.ctx, { subsystem: "check", action: "status" }), 0);
  assert.equal(JSON.parse(fx.output.at(-1)!).counts.experiences, 1);
  assert.equal(existsSync(path.join(fx.root, "unused")), false);
  const falsePositiveLabel = await runCheckLearningOperation(fx.ctx, { action: "capture", value: { ...value,
    id: "experience:cannot-relax-standard", assessment: { ...value.assessment, verdict: "valid" } } }, SIGNAL);

  assert.equal(falsePositiveLabel.exitCode, 1, "a task-owner label cannot silently contradict the frozen schema");
  assert.equal(readFileSync(log, "utf8"), committed, "contradictory gold cannot reach the shared Board");
  const feedback = await runCheckLearningOperation(fx.ctx, { action: "feedback", value: {
    scope: "project:invoice", sessionId: "session:one", turnId: "turn:feedback", sourceRef: "user_explicit:no-run",
    text: "This claimed check never ran.", runIds: ["run:does-not-exist"],
  } }, SIGNAL);

  assert.equal(feedback.exitCode, 1);
  assert.equal(readFileSync(log, "utf8"), committed, "invalid feedback cannot invent exposure");
  assert.equal(fx.counts().configReads, 0);
});

test("corrupt Board management fails explicitly and cancelled input performs no work", async t => {
  const fx = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runCheckLearningOperation(fx.ctx, { action: "status" }, controller.signal);

  assert.equal(cancelled.exitCode, 130);
  assert.equal(existsSync(fx.profile), false);
  const boardRoot = path.join(fx.profile, "learning", "board");
  mkdirSync(boardRoot, { recursive: true });
  writeFileSync(path.join(boardRoot, "board-events.ndjson"), "bad committed log\n");
  assert.equal(await handleCheckLearning(fx.ctx, { subsystem: "check", action: "status" }), 1);
  assert.equal(JSON.parse(fx.output.at(-1)!).ok, false);
  assert.equal(fx.counts().configReads, 0);
});
