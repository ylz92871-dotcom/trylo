import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSkillCoordination } from "../../learning/agent/subsystems/skill/index.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { parseArgs } from "./args.js";
import { dispatch } from "./commands.js";
import { handleSkillControl } from "./commands-skill-control.js";
import type { CliContext } from "./context.js";
import { skillDailyBoard } from "./skill-daily-board.js";

const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 8000 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "trylo-skill-control-")), home = join(root, "home"), out: string[] = [], errors: string[] = [];
  let stdin = "", ids = 0;
  const ctx: CliContext = { env: { TRYLO_HOME: home }, homeDir: root, cwd: root, nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: file => existsSync(file) ? readFileSync(file, "utf8") : undefined,
    isDirectory: file => existsSync(file) && statSync(file).isDirectory(), readDir: () => [], writeFile: () => false,
    readStdin: async () => stdin, readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => out.push(text), stderr: text => errors.push(text), now: () => Date.parse("2026-11-03T18:00:00.000Z"),
    newId: prefix => `${prefix}:${++ids}` };
  const board = skillDailyBoard(join(home, "learning", "board"));
  const service = createSkillCoordination({ board, scope: root, ownerId: "control-test", now: () => new Date(ctx.now()).toISOString() });

  return { ctx, root, board, service, out, errors, stdin: (text: string) => { stdin = text; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function report(h: ReturnType<typeof fixture>, sourceRef = "journal:session:turn") {
  const result = await h.service.report({ sourceRef, taskId: "turn", versionId: "session", facts: ["Observed a reusable correction."], evidenceRefs: [sourceRef] });
  assert.ok(result.ok);
  return { issueId: result.issue.issueId, expectedRevision: result.issue.revision,
    reason: "The user explicitly allocates this reported opportunity.", sourceRefs: [sourceRef], allowance };
}

const last = (h: ReturnType<typeof fixture>): Record<string, unknown> => JSON.parse(h.out.at(-1)!) as Record<string, unknown>;

test("real learn dispatcher discovers skill issues and explicitly focuses them in the canonical workspace Board", async () => {
  const h = fixture();
  try {
    const input = await report(h);

    assert.equal(await dispatch(parseArgs(["learn", "skill", "issues", "--json"]), h.ctx), EXIT_CODES.OK);
    const issues = last(h).issues as { issueId: string }[];

    assert.deepEqual(issues.map(issue => issue.issueId), [input.issueId]);
    assert.equal(last(h).scope, h.root);
    h.stdin(JSON.stringify(input));
    assert.equal(await dispatch(parseArgs(["learn", "skill", "focus", "-"]), h.ctx), EXIT_CODES.OK);
    const loaded = await h.board.load();
    assert.ok(loaded.ok);
    if (!loaded.ok) return;

    assert.equal(loaded.state.centralLearningGrants?.length, 1);
    assert.equal(loaded.state.centralLearningGrants?.[0]?.domain, "skill");
    assert.deepEqual(loaded.state.centralLearningGrants?.[0]?.allowance, allowance);
    assert.equal(loaded.state.jobs[0]?.state, "queued");
    assert.equal(loaded.state.learningGrantFacts?.length ?? 0, 0, "central funding does not mint a legacy output-token grant");
    assert.equal(h.errors.length, 0);
  } finally { h.cleanup(); }
});

test("the controller dispatches only already funded work via the existing runtime callback", async () => {
  const h = fixture();
  let calls = 0, closes = 0;

  try {
    const input = await report(h);
    const worker = async () => {
      calls += 1;
      return { kind: "completed" as const, resultRefs: ["hermes-review:candidate:no_learning"] };
    };
    const factory = (ctx: CliContext) => {
      assert.equal(ctx.cwd, h.root);
      return { coordination: h.service, close: () => { closes += 1; },
        runFocused: (issueId: string, signal: AbortSignal) => h.service.run({ issueId, signal, worker }),
        dispatchFunded: (signal: AbortSignal) => h.service.dispatchFunded({ signal, worker }) };
    };

    assert.equal(await handleSkillControl(h.ctx, { subsystem: "skill", control: "dispatch" }, factory), EXIT_CODES.OK);
    assert.equal(calls, 0);
    assert.equal(last(h).status, "idle");
    h.stdin(JSON.stringify(input));
    assert.equal(await handleSkillControl(h.ctx, { subsystem: "skill", control: "focus" }, factory), EXIT_CODES.OK);
    assert.equal(calls, 0);
    assert.equal(await handleSkillControl(h.ctx, { subsystem: "skill", control: "dispatch", issueId: input.issueId }, factory), EXIT_CODES.OK);
    assert.equal(calls, 1);
    assert.equal(last(h).status, "completed");
    const loaded = await h.board.load();
    assert.ok(loaded.ok);
    if (!loaded.ok) return;

    assert.equal(loaded.state.centralLearningGrants?.length, 1);
    assert.equal(closes, 3);
  } finally { h.cleanup(); }
});

test("invalid focus and workspace failures remain typed before runtime construction; private errors stay private", async () => {
  const h = fixture();
  let constructions = 0;
  const unavailable = () => {
    constructions += 1;
    throw new Error("private endpoint credential=synthetic-private-value");
  };

  try {
    h.stdin(JSON.stringify({ issueId: "one", allowance: { maxOutputTokens: 1 } }));
    assert.equal(await handleSkillControl(h.ctx, { subsystem: "skill", control: "focus" }, unavailable), EXIT_CODES.USAGE);
    assert.equal(last(h).reason, "invalid_skill_focus");
    assert.equal(constructions, 0);
    assert.equal(await handleSkillControl(h.ctx, { subsystem: "skill", control: "issues", workspace: "missing" }, unavailable), EXIT_CODES.USAGE);
    assert.equal(last(h).reason, "workspace_unavailable");
    assert.equal(constructions, 0);
    assert.equal(await handleSkillControl(h.ctx, { subsystem: "skill", control: "issues" }, unavailable), EXIT_CODES.EXECUTION_FAILURE);
    assert.equal(last(h).reason, "hermes_skill_control_unavailable");
    assert.equal(h.out.join("").includes("synthetic-private-value"), false);
  } finally { h.cleanup(); }
});
