import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { contentHashOf } from "../../../../../control/hash.js";
import { requirementDigest } from "../../domain/v2/parse.js";
import type { CheckExperience, CheckInput, CheckRequirements, LearnedChecker } from "../../domain/v2/contracts.js";
import { createBoardReader } from "../../../../../../adapters/learning-store/file-event-store.js";
import type { CheckerEngineOptions, CheckerOutcome, CheckerVersion } from "./contracts.js";
import { decodeCheckerCatalog, readCheckerBoard, saveCheckerRecord } from "../../adapters/board/store.js";
import { recoverCheckerRuns, reserveCheckerRun, runClaimedChecker } from "./run-claims.js";
import type { CheckerRunRequest } from "./run-identity.js";

const ROOT = testScratchPath("checker-run-claims-tests");
const AT = "2026-11-03T00:00:00.000Z";
const SCOPE = "project:run-claims";
const BASIS = { text: "Invoice total must be nonnegative; zero is valid.", schema: { type: "object", properties: { total: { type: "number", minimum: 0 } }, required: ["total"] } };
const REQUIREMENTS: CheckRequirements = { ...BASIS, ref: "requirement:total-v1", digest: requirementDigest(BASIS) };
const PASS: CheckerOutcome = { kind: "checked", verdict: { status: "pass", findings: [] } };

function input(total = 1): CheckInput { return { task: { instruction: "Check invoice total.", requirementRef: REQUIREMENTS.ref,
  requirementDigest: REQUIREMENTS.digest }, phase: "before_completion", output: { total } }; }

async function fixture(t: { after(run: () => Promise<void>): void }) {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(path.join(ROOT, "case-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, "board");
  const experience: CheckExperience = { schemaVersion: 2, type: "check_experience", id: "experience:source", scope: SCOPE,
    sessionId: "source-session", turnId: "source-turn", requirements: REQUIREMENTS, facts: input(), priorRuns: [] };
  const saved = await saveCheckerRecord(boardRoot, experience, AT);
  assert.ok(saved.ok, JSON.stringify(saved));
  const checker: LearnedChecker = { schemaVersion: 2, type: "learned_checker", question: "Is the invoice total valid?", claim: "Check the task total requirement.",
    applicability: { scope: SCOPE, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest,
      requiredKeys: ["total"], excludedKeys: [], instructionIncludes: [] }, timing: ["before_completion"],
    source: 'module.exports = input => ({status:"pass",findings:[]});', sourceRefs: [experience.id] };
  const version: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker, requirements: REQUIREMENTS,
    experienceRefs: [saved.versionId], generation: { requestId: "generation:unit", model: "test-only", usage: { inputTokens: 1, outputTokens: 1 } } };
  const stored = await saveCheckerRecord(boardRoot, version, AT);
  assert.ok(stored.ok, JSON.stringify(stored));
  const states = new Map<string, "alive" | "dead" | "unknown">([["owner:first", "alive"], ["owner:restart", "alive"]]);
  const options: CheckerEngineOptions = { boardRoot, collection: () => "enabled", now: () => Date.parse(AT),
    owner: { id: "owner:first", alive: async id => states.get(id) ?? "unknown" },
    generator: { generate: async () => { throw new Error("unit claim tests never call a model"); } },
    executor: { execute: async () => { throw new Error("the injected execution callback owns this test"); } } };
  const request = (runId: string, total = 1, turnId = "turn:one"): CheckerRunRequest => ({ runId, versionId: stored.versionId,
    scope: SCOPE, sessionId: "session:one", turnId, requirements: REQUIREMENTS, input: input(total), inputDigest: contentHashOf(input(total)) });

  return { root, boardRoot, options, request, states };
}

test("persisted claim serializes contenders and a terminal replay never executes again", async t => {
  const fx = await fixture(t);
  const request = fx.request("run:one");
  let calls = 0;
  let entered!: () => void, release!: () => void;
  const executing = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const first = runClaimedChecker(fx.options, request, async () => {
    calls += 1;
    entered();
    await hold;
    return PASS;
  });

  await executing;
  const concurrent = await runClaimedChecker(fx.options, request, async () => {
    calls += 1;
    return PASS;
  });

  assert.ok(concurrent.ok);
  assert.equal(concurrent.reason, "waiting");
  assert.equal(calls, 1);
  release();
  const completed = await first;
  assert.ok(completed.ok && completed.run !== undefined, JSON.stringify(completed));
  const reopened = { ...fx.options, owner: { ...fx.options.owner, id: "owner:restart" } };
  const replay = await runClaimedChecker(reopened, request, async () => {
    calls += 1;
    return PASS;
  });

  assert.ok(replay.ok);
  assert.deepEqual(replay.run, completed.run);
  assert.equal(calls, 1);
  const state = await readCheckerBoard(fx.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.runClaims.length, 1);
  assert.equal(state.catalog.runs.length, 1);
});

test("turn quota includes in-flight reservations and terminal replay wins before quota denial", async t => {
  const fx = await fixture(t);
  let calls = 0;
  const releases: (() => void)[] = [];
  const pending: Promise<Awaited<ReturnType<typeof runClaimedChecker>>>[] = [];

  for (let index = 0; index < 3; index += 1) {
    let entered!: () => void;
    const executing = new Promise<void>(resolve => { entered = resolve; });
    pending.push(runClaimedChecker(fx.options, fx.request(`run:${index}`, index), async () => {
      calls += 1;
      await new Promise<void>(resolve => {
        releases.push(resolve);
        entered();
      });
      return PASS;
    }));
    await executing;
  }

  const overrun = await runClaimedChecker(fx.options, fx.request("run:four", 4), async () => {
    calls += 1;
    return PASS;
  });

  assert.ok(overrun.ok);
  assert.equal(overrun.reason, "turn_budget_exhausted");
  assert.equal(calls, 3);

  // Settle one by one to keep this assertion about quota, not simultaneous terminal writer contention.
  for (const [index, release] of releases.entries()) {
    release();
    assert.equal((await pending[index]!).ok, true);
  }

  const replay = await runClaimedChecker(fx.options, fx.request("run:0", 0), async () => {
    calls += 1;
    return PASS;
  });

  assert.ok(replay.ok && replay.run !== undefined);
  assert.equal(replay.reason, "completed");
  assert.equal(calls, 3);
  const nextTurn = await runClaimedChecker(fx.options, fx.request("run:next-turn", 4, "turn:two"), async () => {
    calls += 1;
    return PASS;
  });

  assert.ok(nextTurn.ok && nextTurn.run !== undefined);
  assert.equal(calls, 4);
});

test("restart closes a positively dead owner as outcome_unknown without repeating its execution", async t => {
  const fx = await fixture(t);
  const request = fx.request("run:orphan");
  const reserved = await reserveCheckerRun(fx.options, request);
  assert.ok(reserved.ok && reserved.claimed);
  fx.states.set("owner:first", "dead");
  let calls = 0;
  const reopened = { ...fx.options, owner: { ...fx.options.owner, id: "owner:restart" } };
  const recovered = await recoverCheckerRuns(reopened);
  assert.ok(recovered.ok);
  assert.deepEqual(recovered.recovered, [request.runId]);
  const replay = await runClaimedChecker(reopened, request, async () => {
    calls += 1;
    return PASS;
  });

  assert.ok(replay.ok && replay.run !== undefined);
  assert.deepEqual(replay.run.outcome, { kind: "checker_error", code: "outcome_unknown" });
  assert.equal(calls, 0);
  assert.equal(replay.claimed, false);
  const repeated = await recoverCheckerRuns(reopened);
  assert.ok(repeated.ok);
  assert.deepEqual(repeated.recovered, []);
});

test("unknown or failing liveness probes do not prove owner death", async t => {
  const fx = await fixture(t);
  const request = fx.request("run:unknown-owner");

  assert.equal((await reserveCheckerRun(fx.options, request)).ok, true);
  fx.states.set("owner:first", "unknown");
  const first = await reserveCheckerRun(fx.options, request);
  assert.ok(first.ok && !first.claimed);
  assert.equal(first.reason, "waiting");
  const broken = { ...fx.options, owner: { id: "owner:restart", alive: async () => { throw new Error("probe failed"); } } };
  const second = await reserveCheckerRun(broken, request);
  assert.ok(second.ok && !second.claimed);
  assert.equal(second.reason, "waiting");
  const state = await readCheckerBoard(fx.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.runs.length, 0);
});

test("cancelled and disabled dispatches perform no reservation; executor faults remain checker errors", async t => {
  const fx = await fixture(t);
  let calls = 0;
  const cancelled = new AbortController();
  cancelled.abort();
  const before = await runClaimedChecker(fx.options, fx.request("run:cancelled"), async () => {
    calls += 1;
    return PASS;
  }, cancelled.signal);

  assert.ok(before.ok);
  assert.equal(before.reason, "cancelled");
  const disabled = await runClaimedChecker({ ...fx.options, collection: () => "disabled" }, fx.request("run:private"), async () => {
    calls += 1;
    return PASS;
  });

  assert.ok(disabled.ok);
  assert.equal(disabled.reason, "collection_disabled");
  assert.equal(calls, 0);
  const empty = await readCheckerBoard(fx.boardRoot);
  assert.ok(empty.ok);
  assert.equal(empty.catalog.runClaims.length, 0);
  const privateInput: CheckInput = { ...input(), output: { total: 1, apiKey: "DEVELOPMENT-ONLY-NOT-A-CREDENTIAL" } };
  const privateRun = await runClaimedChecker(fx.options, { ...fx.request("run:credential"), input: privateInput,
    inputDigest: contentHashOf(privateInput) }, async () => {
      calls += 1;
      return PASS;
    });

  assert.equal(privateRun.ok, false);
  assert.equal(calls, 0);
  const failure = await runClaimedChecker(fx.options, fx.request("run:crash"), async () => { throw new Error("worker crashed"); });

  assert.ok(failure.ok && failure.run !== undefined);
  assert.deepEqual(failure.run.outcome, { kind: "checker_error", code: "executor_threw" });
  const malformed = await runClaimedChecker(fx.options, fx.request("run:wrong-criterion"), async () => ({ kind: "checked",
    verdict: { status: "fail", findings: [{ requirementRef: "some-other-requirement", message: "wrong source" }] } }));

  assert.ok(malformed.ok && malformed.run !== undefined);
  assert.deepEqual(malformed.run.outcome, { kind: "checker_error", code: "invalid_verdict" });
});

test("a run identity cannot move to another input, version, session or requirement", async t => {
  const fx = await fixture(t);
  const request = fx.request("run:identity");
  const completed = await runClaimedChecker(fx.options, request, async () => PASS);
  assert.ok(completed.ok && completed.run !== undefined);

  for (const changed of [fx.request(request.runId, 9), { ...request, sessionId: "other-session" }, { ...request, versionId: "checker:unknown" }]) {
    const result = await reserveCheckerRun(fx.options, changed);
    assert.equal(result.ok, false, JSON.stringify(result));
  }

  const fresh = await reserveCheckerRun(fx.options, { ...fx.request("run:unbound"), inputDigest: "0".repeat(64) });

  assert.equal(fresh.ok, false);
});

test("late cancellation or collection disable closes its consumed reservation without a quality verdict", async t => {
  const fx = await fixture(t);
  const cancelled = new AbortController();
  const first = await runClaimedChecker(fx.options, fx.request("run:late-cancel"), async () => {
    cancelled.abort();
    return PASS;
  }, cancelled.signal);

  assert.ok(first.ok && first.run !== undefined);
  assert.deepEqual(first.run.outcome, { kind: "cancelled" });
  let enabled = true;
  const second = await runClaimedChecker({ ...fx.options, collection: () => enabled ? "enabled" : "disabled" }, fx.request("run:late-private"), async () => {
    enabled = false;
    return PASS;
  });

  assert.ok(second.ok && second.run !== undefined);
  assert.deepEqual(second.run.outcome, { kind: "cancelled" });
  const state = await readCheckerBoard(fx.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.runClaims.length, 2);
  assert.equal(state.catalog.runs.filter(run => run.outcome.kind === "checked").length, 0);
});

test("terminal readback requires its exact preceding claim", async t => {
  const fx = await fixture(t);
  const result = await runClaimedChecker(fx.options, fx.request("run:binding"), async () => PASS);
  assert.ok(result.ok && result.run !== undefined);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  const removed = decodeCheckerCatalog({ ...loaded.state, assets: loaded.state.assets.filter(asset => !asset.versionId.startsWith("checker:checker_run_claim:")) });
  assert.equal(removed.ok, false, "a terminal cannot fabricate exposure without a reserved run");
});

test("real child death after durable reservation recovers unknown and never calls the checker", async t => {
  const fx = await fixture(t);
  const request = fx.request("run:real-owner");
  const moduleUrl = new URL("./run-claims.js", import.meta.url).href;
  const source = `import {reserveCheckerRun} from ${JSON.stringify(moduleUrl)};
    const request=JSON.parse(Buffer.from(process.argv[2],'base64').toString('utf8'));
    const options={boardRoot:process.argv[1],collection:()=>"enabled",now:()=>${Date.parse(AT)},owner:{id:"process:"+process.pid,alive:async()=>"alive"},
      generator:{generate:async()=>{throw new Error("not used")}},executor:{execute:async()=>{throw new Error("not used")}}};
    const result=await reserveCheckerRun(options,request); if(!result.ok||!result.claimed) throw new Error(JSON.stringify(result));
    process.stdout.write("CLAIMED\\n"); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, fx.boardRoot, Buffer.from(JSON.stringify(request)).toString("base64")],
    { cwd: fx.root, env: {}, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = "", stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (value: string) => { stderr += value; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`owned child did not reserve: ${stderr}`)), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      output += value;
      if (output.includes("CLAIMED")) {
      clearTimeout(timeout);
      resolve();
    }
    });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => { if (!output.includes("CLAIMED")) {
      clearTimeout(timeout);
      reject(new Error(stderr));
    } });
  });
  const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); });
  child.kill();
  await exited;
  let calls = 0;
  const restarted = { ...fx.options, owner: { id: "owner:restart", alive: async (id: string): Promise<"alive" | "dead" | "unknown"> =>
    id === `process:${child.pid}` && (child.exitCode !== null || child.signalCode !== null) ? "dead" : "unknown" } };
  const recovery = await recoverCheckerRuns(restarted);
  assert.ok(recovery.ok);
  assert.deepEqual(recovery.recovered, [request.runId]);
  const repeated = await runClaimedChecker(restarted, request, async () => {
    calls += 1;
    return PASS;
  });

  assert.ok(repeated.ok && repeated.run !== undefined);
  assert.deepEqual(repeated.run.outcome, { kind: "checker_error", code: "outcome_unknown" });
  assert.equal(calls, 0);
});
