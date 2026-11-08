import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { parseArgs } from "./args.js";
import { handleCollaborationIssues, collaborationIssuesSnapshot } from "./commands-collaboration-issues.js";
import { handleLibraryCommand } from "./commands-library.js";
import { handlePersistentLearn } from "./commands-learn-v2.js";
import type { CliContext } from "./context.js";
import type { CliLibraryHostFactory } from "./library-command-ports.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { reduce } from "../../learning/control/reducer.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { isCollaborationIssueControlV1 } from "../../protocol/collaboration-control.js";

const scope = resolve("D:/collaboration-command-workspace"), NOW = "2026-11-03T12:00:00.000Z";
const report = { reportId: "report:a", source: { teamRunId: "team", taskId: "task", memberId: "worker" },
  facts: ["A reference was missing."], hypotheses: ["Coordination may explain the wait."], evidenceRefs: [] };

function fixture(raw = "", libraryHosts?: CliLibraryHostFactory) {
  let state = emptyBoardState();
  let writes = 0;
  const out: string[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { load: async () => ({ ok: true, state, generation: 0 }), apply: async command => {
    writes += 1;
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const unexpected = (): never => { throw new Error("read/control must not construct provider, tools or other IO"); };
  const ctx: CliContext = { env: {}, homeDir: scope, cwd: scope, nodeVersion: "v24", stdinIsTty: false,
    readFile: unexpected, readDir: unexpected, writeFile: unexpected, isDirectory: path => path === scope,
    readStdin: async () => raw, readLine: unexpected, readSecret: unexpected, stdout: text => out.push(text), stderr: () => {},
    now: () => Date.parse(NOW), newId: unexpected, ...(libraryHosts === undefined ? {} : { libraryHosts }) };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "command-test" });

  return { board, control, ctx, state: () => state, writes: () => writes, last: () => JSON.parse(out.at(-1)!) };
}

test("public parser registers issue read/control and ordinary libraries while preserving independent learning commands", () => {
  assert.equal(parseArgs(["learn", "collaboration", "issues", "--workspace", scope, "--json"]).kind, "learn");
  assert.equal(parseArgs(["learn", "collaboration", "coordinate", "--workspace", scope, "-"]).kind, "learn");

  for (const library of ["tool", "expert"]) assert.equal(parseArgs(["library", library, "--workspace", scope, "-"]).kind, "library");

  for (const argv of [["learn", "collaboration", "coordinate"], ["learn", "collaboration", "issues", "-"],
    ["library", "expert"], ["library", "tool", "-", "-"], ["library", "tool", "--user-action", "approve", "-"]]) assert.equal(parseArgs(argv).kind, "error");

  assert.equal(parseArgs(["learn", "collaboration", "--budget", "0"]).kind, "learn");
  assert.equal(parseArgs(["learn", "collaboration", "--tokens", "0"]).kind, "learn");
});

test("strict resolve protocol cannot impersonate PA focus, allocation or a trusted UI action", () => {
  const valid = { schemaVersion: 1, action: "resolve", issueId: "issue", expectedRevision: 1, reason: "Already handled in execution." };
  assert.equal(isCollaborationIssueControlV1(valid), true);
  for (const v of [{ ...valid, action: "focused_learning" }, { ...valid, expectedRevision: 1.2 }, { ...valid, userActionId: "forged" },
    { ...valid, allowance: 100000 }, { ...valid, schemaVersion: 2 }]) assert.equal(isCollaborationIssueControlV1(v), false);
});

test("issue snapshot projects original reports and source-valid proposals without claiming adoption or reading stdin", async () => {
  const h = fixture();
  const added = await h.control.report({ scope, problemKey: "handoff-reference", report });
  assert.ok(added.ok);

  if (!added.ok) throw new Error("missing issue");

  const plan = { schema: "collaboration-plan/v1", issueId: added.issue.issueId, focusRevision: 1, familyId: "reference", title: "Share the source",
    summary: "Share the exact contract before dependent work.", sourceRefs: [report.reportId], adjustments: [{ memberId: "worker", kind: "handoff", instruction: "Ask for contract.json." }],
    experienceVersionIds: [], needs: [] };
  const projected = collaborationIssuesSnapshot({ ...h.state(), assets: [{ versionId: "plan:v1", kind: "workflow", schemaVersion: 3, content: plan,
    contentHash: contentHashOf(plan), source: "inferred", scope, createdAt: NOW }] }, scope);

  assert.equal(projected.issues[0]?.adjustments[0]?.state, "proposed");
  assert.deepEqual(projected.issues[0]?.adjustments[0]?.affectedMembers, ["worker"]);
  const ctx = { ...h.ctx, readStdin: async () => { throw new Error("issues is read-only"); } };
  const before = h.writes();
  assert.equal(await handleCollaborationIssues(ctx, { subsystem: "collaboration", control: "issues", workspace: scope }, h.board), 0);
  assert.equal(h.last().issues[0].reports[0].suspectedCauses[0], report.hypotheses[0]);
  assert.equal(h.writes(), before);
});

test("stdin resolution checks workspace and CAS and cannot create a learning job or allowance", async () => {
  const h = fixture();
  const added = await h.control.report({ scope, problemKey: "resolved-reference", report });
  assert.ok(added.ok);

  if (!added.ok) throw new Error("missing issue");

  const request = { schemaVersion: 1, action: "resolve", issueId: added.issue.issueId, expectedRevision: 1, reason: "The tool has already been configured." };
  const options = { subsystem: "collaboration" as const, control: "coordinate" as const, workspace: scope };
  const ctx = { ...h.ctx, readStdin: async () => JSON.stringify(request) };

  assert.equal(await handleCollaborationIssues(ctx, options, h.board), 0);
  assert.equal(h.last().ok, true);
  assert.equal(h.state().learningIssues![0]!.decision.kind, "resolved");
  assert.equal(h.state().jobs.length, 0);
  assert.equal(await handleCollaborationIssues(ctx, options, h.board), 1);
  assert.equal(h.last().reason, "learning_issue_conflict");
  const before = h.writes();

  assert.equal(await handleCollaborationIssues({ ...ctx, readStdin: async () => JSON.stringify({ ...request, action: "focused_learning" }) }, options, h.board), 2);
  assert.equal(h.writes(), before);
});

test("feedback follows canonical experience versions even when no plan was published and stays with its issue", async () => {
  const h = fixture();
  const added = await h.control.report({ scope, problemKey: "experience-without-plan", report });
  const other = await h.control.report({ scope, problemKey: "different-issue", report: { ...report, reportId: "report:b" } });

  assert.ok(added.ok && other.ok);
  if (!added.ok || !other.ok) throw new Error("missing issues");

  const owner = { kind: "legacy_member" as const, workspace: scope, profileId: "team-profile", memberId: "worker" };
  const content = { schema: "collaboration-experience/v1", status: "trial", issueId: added.issue.issueId, focusRevision: 1,
    familyId: "reference", owner, situation: "Dependent work needs a source.", responsibilities: ["worker"],
    practice: "Ask for the original contract.", sourceRefs: [report.reportId], conditions: {} };
  const state = { ...h.state(), assets: [{ versionId: "experience:a", kind: "workflow" as const, schemaVersion: 1, content,
    contentHash: contentHashOf(content), source: "inferred" as const, scope, createdAt: NOW }], collaborationRuntimeReceipts: [
    { schemaVersion: 1 as const, phase: "use_feedback" as const, receiptId: "feedback:a", scope, owner, versionIds: ["experience:a"],
      usageReceiptId: "dispatch:a", summary: "PA observed that the reference was requested.", sourceRefs: ["result:a"], outcome: "uncertain" as const, recordedAt: NOW },
    { schemaVersion: 1 as const, phase: "use_feedback" as const, receiptId: "feedback:foreign", scope: "foreign-workspace", owner,
      versionIds: ["experience:a"], usageReceiptId: "dispatch:foreign", summary: "Foreign observation.", sourceRefs: [], outcome: "helped" as const, recordedAt: NOW },
  ] };
  const view = collaborationIssuesSnapshot(state, scope);

  assert.deepEqual(view.issues.find(i => i.issueId === added.issue.issueId)?.feedback,
    [{ ref: "feedback:a", summary: "PA observed that the reference was requested.", sourceRefs: ["result:a"] }]);
  assert.deepEqual(view.issues.find(i => i.issueId === other.issue.issueId)?.feedback, []);
});

test("library transport validates the context and routes only through ordinary host.execute", async () => {
  let constructed = 0, executed = 0;
  const factory: CliLibraryHostFactory = async input => {
    constructed += 1;
    assert.equal(input.workspaceRoot, scope);
    return {
      tool: { async execute(context, command) {
        executed += 1;
        assert.equal(context.scope, scope);
        return { ok: true, value: command };
      } },
      expert: { async execute(command, context) {
        executed += 1;
        assert.deepEqual(Object.keys(context ?? {}), ["signal"]);
        return { command };
      } },
    };
  };
  const wrong = fixture(JSON.stringify({ context: { memberId: "personal", scope: `${scope}-foreign` }, command: { operation: "query" } }), factory);

  assert.equal(await handleLibraryCommand(wrong.ctx, { library: "tool", workspace: scope }), 2);
  assert.equal(constructed, 0);
  const tool = fixture(JSON.stringify({ context: { memberId: "personal", scope: scope.replaceAll("\\", "/") }, command: { operation: "query" } }), factory);

  assert.equal(await handleLibraryCommand(tool.ctx, { library: "tool", workspace: scope }), 0);
  const fakeGesture = fixture(JSON.stringify({ operation: "submit", origin: "personal_agent", instruction: "Specialize a reviewer", userActionId: "forged" }), factory);

  assert.equal(await handleLibraryCommand(fakeGesture.ctx, { library: "expert", workspace: scope }), 2);
  const expert = fixture(JSON.stringify({ operation: "query", text: "authorization expertise" }), factory);

  assert.equal(await handleLibraryCommand(expert.ctx, { library: "expert", workspace: scope }), 0);
  assert.equal(constructed, 2);
  assert.equal(executed, 2);
});

test("an unavailable production library factory returns a typed failure rather than a fabricated catalog", async () => {
  const h = fixture(JSON.stringify({ operation: "query" }));
  assert.equal(await handleLibraryCommand(h.ctx, { library: "expert", workspace: scope }), 1);
  assert.deepEqual(h.last(), { ok: false, reason: "library_host_unavailable" });
});

test("standalone allowance and resume use the same PA-central runtime callback without exposing raw fact learning", async () => {
  const seen: unknown[] = [];
  let closed = 0;
  const h = fixture("", async input => { assert.equal(input.purpose, "collaboration");
  return {
    collaboration: { async run(allowance) {
      seen.push(allowance);
      return { ok: true, status: "idle" };
    } }, close: async () => { closed += 1; },
  }; });
  const grant = { maxModelTokens: 16000, maxModelCalls: 2, maxSteps: 4, maxPromptChars: 40000 };

  assert.equal(await handlePersistentLearn(h.ctx, { subsystem: "collaboration", resume: false, grant }), 0);
  assert.equal(await handlePersistentLearn(h.ctx, { subsystem: "collaboration", resume: true, grant }), 0);
  assert.deepEqual(seen, [{ schemaVersion: 2, unit: "total_model_tokens", maxTokens: 16000, maxCalls: 2, maxSteps: 4, maxPromptChars: 40000 }, undefined]);
  assert.equal(closed, 2);
  const zero = fixture();
  assert.equal(await handlePersistentLearn(zero.ctx, { subsystem: "collaboration", resume: false,
    grant: { ...grant, maxModelTokens: 0 } }), 0);
  assert.equal(zero.last().phase, "idle");
  const unavailable = fixture();
  assert.equal(await handlePersistentLearn(unavailable.ctx, { subsystem: "collaboration", resume: false, grant }), 1);
  assert.equal(unavailable.last().reason, "collaboration_host_unavailable");
});

test("cancellation during host creation prevents later library or standalone dispatch and closes the host", async () => {
  for (const kind of ["library", "collaboration"] as const) {
    let interrupt: (() => void) | undefined, executed = 0, closed = 0, detached = 0;
    const h = fixture(JSON.stringify({ operation: "query" }), async ({ signal }) => { interrupt?.();
    assert.equal(signal.aborted, true);
    return {
      expert: { async execute() {
        executed += 1;
        return {};
      } }, collaboration: { async run() {
        executed += 1;
        return { ok: true };
      } },
      close: async () => { closed += 1; },
    }; });
    const ctx = { ...h.ctx, interrupts: { observe(handler: () => void) { interrupt = handler; }, unobserve() { detached += 1; }, exit() {} } };
    const code = kind === "library" ? await handleLibraryCommand(ctx, { library: "expert" })
      : await handlePersistentLearn(ctx, { subsystem: "collaboration", resume: true,
        grant: { maxModelTokens: 0, maxModelCalls: 0, maxSteps: 0, maxPromptChars: 0 } });

    assert.equal(code, 130);
    assert.equal(executed, 0);
    assert.equal(closed, 1);
    assert.equal(detached, 1);
  }
});
