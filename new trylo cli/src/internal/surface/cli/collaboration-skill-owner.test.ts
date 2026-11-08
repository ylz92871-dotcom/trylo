import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/index.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { COLLABORATION_SKILL_FOCUS_REQUIRED } from "../../learning/agent/subsystems/collaboration/personal-agent/index.js";
import { createPersonalAgentRuntime } from "./collaboration-personal-agent-wiring.js";
import { methodBoardRoot } from "./learning-sink.js";
import { createDenyAllPermission } from "./permission.js";

const NOW = "2026-11-04T00:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 40000, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 };
const unexpected = (): never => { throw new Error("Skill ownership protection must not enter business IO or models"); };

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-pa-skill-owner-")), scope = path.join(root, "workspace");
  mkdirSync(scope);
  t.after(() => {
    assert.equal(path.dirname(root), tmpdir());
    assert.match(path.basename(root), /^trylo-pa-skill-owner-/);
    rmSync(root, { recursive: true, force: true });
  });
  const calls = { fork: 0, stream: 0 };
  const provider: ProviderPort = { stream: () => {
    calls.stream++;
    return unexpected();
  }, fork: () => {
    calls.fork++;
    return { stream: unexpected };
  } };
  const tools: ToolPort = { snapshot: () => [], execute: unexpected, cancel: unexpected };
  const runtime = createPersonalAgentRuntime({ homeDir: root, env: {}, scope, turnId: "owner-turn", choice: allowance.maxTokens,
    now: () => Date.parse(NOW), warn: unexpected, newOwnerId: () => "owner-runtime", model: "local-development-only", provider,
    tools, workspaceTools: tools, permission: createDenyAllPermission(), grants: createPermissionGrantCache(),
    sandbox: { policy: { mode: "deny_all", network: "restricted", workspaceRoot: scope, maxWriteBytes: 0, allowAbsoluteExecutable: false }, evaluate: unexpected } });

  t.after(() => runtime.close());

  return { runtime, calls, scope, board: createFileCollaborationBoard(methodBoardRoot(root, {})) };
}

async function focusedSkill(h: ReturnType<typeof fixture>) {
  const report = await h.runtime.control.report({ scope: h.scope, problemKey: "procedural", report: { reportId: "skill-source",
    source: { subsystem: "skill", taskId: "skill-turn", versionId: "skill-session" }, facts: ["Observed procedural source."], evidenceRefs: [] } });
  assert.ok(report.ok);
  const decision = await h.runtime.control.decide({ issueId: report.issue.issueId, expectedRevision: report.issue.revision,
    decision: "focused_learning", reason: "Existing focused source fixture.", sourceRefs: ["skill-source"] });
  assert.ok(decision.ok);
  return decision.issue;
}

test("production independent collaboration allowance cannot fund a focused skill source", async t => {
  const h = fixture(t), issue = await focusedSkill(h);
  const result = await h.runtime.learn(allowance, new AbortController().signal);
  assert.ok(result.ok);
  assert.equal(result.status, "idle");
  const loaded = await h.board.load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.centralLearningGrants?.length ?? 0, 0);
  assert.equal(loaded.state.jobs.length, 0);
  assert.equal(loaded.state.learningIssues?.find(item => item.issueId === issue.issueId)?.revision, issue.revision);
  assert.deepEqual(h.calls, { fork: 0, stream: 0 });
});

test("production worker rejects a previously misfunded collaboration job before any model use without migrating its grant", async t => {
  const h = fixture(t), issue = await focusedSkill(h);
  // Reproduce the existing generic fund default explicitly as historical input.
  const funded = await h.runtime.control.fund({ issueId: issue.issueId, expectedRevision: issue.revision,
    grantId: "historical-wrong-owner", allowance });
  assert.ok(funded.ok);
  const result = await h.runtime.learn(undefined, new AbortController().signal);
  assert.ok(result.ok);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.result, { kind: "failed", reason: COLLABORATION_SKILL_FOCUS_REQUIRED });
  assert.deepEqual(h.calls, { fork: 0, stream: 0 });
  const loaded = await h.board.load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.centralLearningGrants?.length, 1);
  const grant = loaded.state.centralLearningGrants?.[0];
  assert.ok(grant);
  assert.equal(grant.grantId, "historical-wrong-owner");
  assert.equal(grant.domain, funded.grant.domain);
  assert.equal(loaded.state.jobs.find(job => job.jobId === funded.jobId)?.domain, "collaboration");
  assert.equal(loaded.state.jobs.find(job => job.jobId === funded.jobId)?.state, "failed");
  assert.deepEqual(grant.reservations, []);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 0, calls: 0, steps: 0 });
});
