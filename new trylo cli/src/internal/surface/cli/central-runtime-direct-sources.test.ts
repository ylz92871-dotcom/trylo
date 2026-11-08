import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import type { CentralRuntimeWake } from "../../adapters/central-learning-runtime/contracts.js";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/central.js";
import { createCollaborationSubsystemV2 } from "../../learning/agent/subsystems/collaboration/domain/v2-service.js";
import type { CollaborationV2Context } from "../../learning/agent/subsystems/collaboration/domain/v2-contracts.js";
import { mapSkillDraft } from "../../integration/content/skill.js";
import { induceSkill, type SkillEpisode } from "../../learning/domains/skill/index.js";
import { handleCollaborationGovernance } from "./commands-collaboration-governance.js";
import { handleCollaborationIssues } from "./commands-collaboration-issues.js";
import { createSkillDailyManagement, skillDailyManagementPaths } from "./skill-daily-management.js";
import type { CliContext } from "./context.js";

test("committed collaboration correction, resolution and legacy skill withdrawal wake the existing original scope owner without a business turn", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-direct-source-wake-")), homeRoot = path.join(root, "home"), scope = path.join(root, "original-workspace");

  mkdirSync(scope);
  const stdout: string[] = [], stderr: string[] = [];
  let id = 0;
  const ctx: CliContext = { cwd: path.join(root, "unrelated-workspace"), homeDir: root, env: { TRYLO_HOME: homeRoot }, nodeVersion: "v24", stdinIsTty: false,
    readFile: () => undefined, readDir: () => [], writeFile: () => false, isDirectory: value => value === scope,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => stdout.push(text), stderr: text => stderr.push(text), now: () => Date.parse("2026-11-05T00:00:00.000Z"), newId: prefix => `${prefix}:${++id}` };
  const paths = runtimeScopePaths(homeRoot, scope), seen = new Map<string, CentralRuntimeWake>(), waiters = new Map<string, () => void>();
  const runtime = await serveCentralRuntime({ paths, configuration: {}, driver: { async drive(input) {
    assert.equal(input.scope.workspaceRoot, scope);
    seen.set(input.wake.reason, input.wake);
    waiters.get(input.wake.reason)?.();
    return { state: "waiting", reason: "original_source_observed_without_inference" };
  } } });

  t.after(async () => { await runtime.close("restart");
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-direct-source-wake-"));
  rmSync(root, { recursive: true, force: true }); });
  const waitFor = async (reason: string) => {
    if (!seen.has(reason)) { let timer: ReturnType<typeof setTimeout> | undefined;
      try { await new Promise<void>((resolve, reject) => {
        waiters.set(reason, resolve);
        timer = setTimeout(() => reject(new Error(`Missing original owner notification: ${reason}`)), 3000);
      }); }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        waiters.delete(reason);
      } }
    return seen.get(reason)!;
  };
  const board = createFileCollaborationBoard(path.join(homeRoot, "learning", "board")), at = new Date(ctx.now()).toISOString();
  const context: CollaborationV2Context = { scope, teamRunId: "team:original", taskId: "task:original", round: 1, memberId: "worker", role: "worker",
    taskFamily: "handoff", dependency: "artifact", coordinationMode: "sequential", difficulty: "unknown", members: [{ memberId: "worker", role: "worker" }] };
  const legacy = createCollaborationSubsystemV2({ board, ownerId: "original-fixture-owner", now: () => at, analyzer: {
    async analyze({ window }) { return { status: "proposed", tokenCost: 1, usage: { status: "reported", totalTokens: 1, elapsedMs: 1 }, proposals: [{
      familyId: "original-reference", title: "Keep the original reference", hypothesis: "A missing reference may explain waiting",
      alternatives: [{ cause: "coordination", explanation: "The reference was omitted", evidenceRefs: ["event:original-request"] },
        { cause: "unknown", explanation: "Access may be unavailable", evidenceRefs: ["event:original-request"] }],
      discriminator: { observation: "Inspect the actual delivered reference", distinguishes: ["coordination", "unknown"] },
      conditions: { dependency: "artifact", taskFamilies: ["handoff"], roles: [], coordinationModes: [], difficulty: [], minimumMembers: 1 },
      actions: [{ actionId: "request-reference", dimension: "handoff", audience: "member", operation: "request_context",
        instruction: "Request the exact prerequisite reference", expectedObservable: "An actual reference is delivered" }], failureConditions: ["The reference is already present"],
      sourceEventIds: window.events.map(event => event.factId), sourceEpisodeIds: [], sourceOutcomeIds: [] }] }; } } });

  assert.ok((await legacy.observe({ schemaVersion: 2, kind: "event", factId: "event:original-request", scope, recordedAt: at, context,
    dimension: "handoff", action: "request_context", summary: "Requested an actual prerequisite", source: "runtime", evidenceRefs: ["execution:original"], causedBy: [], metrics: {} })).ok);
  assert.ok((await legacy.invoke({ subsystem: "collaboration", scope, requestId: "original-fixture", grant: { maxSteps: 1, maxModelCalls: 1, maxModelTokens: 1000, maxPromptChars: 4000 } })).ok);
  assert.equal(await handleCollaborationGovernance(ctx, { subsystem: "collaboration", operation: "correct", workspace: scope, familyId: "original-reference",
    action: "suspend", appliesTo: { kind: "workspace" }, evidenceRef: "user:actual-correction" }), 0);
  const correctionId = JSON.parse(stdout.at(-1)!).correctionId as string;

  assert.deepEqual((await waitFor("collaboration_user_correction_committed")).sourceRefs, [correctionId]);
  const control = createCollaborationControl({ board, ownerId: "original-report-owner", now: () => at });
  const reported = await control.report({ scope, problemKey: "original-issue", report: { reportId: "report:original-issue",
    source: { teamRunId: "team:original", taskId: "task:original", memberId: "worker" }, facts: ["The actual prerequisite was missing"], evidenceRefs: ["execution:original"] } });
  assert.ok(reported.ok);
  const request = { schemaVersion: 1, action: "resolve", issueId: reported.issue.issueId, expectedRevision: reported.issue.revision, reason: "The user resolved the original issue" };

  assert.equal(await handleCollaborationIssues({ ...ctx, readStdin: async () => JSON.stringify(request) },
    { subsystem: "collaboration", control: "coordinate", workspace: scope }), 0);
  const resolution = await waitFor("collaboration_issue_resolution_committed"), resolved = await board.load();
  assert.ok(resolved.ok);
  const issue = resolved.state.learningIssues!.find(item => item.issueId === reported.issue.issueId)!;
  assert.equal(issue.decision.kind, "resolved");
  assert.deepEqual(resolution.sourceRefs, [issue.issueId, ...issue.decision.sourceRefs]);
  const skillCtx = { ...ctx, cwd: scope }, skillPaths = skillDailyManagementPaths(skillCtx);
  const family = { id: "report", intentClass: "normalize_report", checkKind: "acceptance" as const };
  const episode = (key: string, outcome: "success" | "failure"): SkillEpisode => ({ id: key, outcome, taskFamily: family,
    trajectory: { nodeIds: ["read", "check"], stepCount: 2, hadChecks: true, hadFailureRecovery: false },
    steps: ["read all rows", "retain zero values"], checks: ["independent report check"], ...(outcome === "failure" ? { failureMode: "zero rows lost" } : {}) });
  const induced = induceSkill([episode("s1", "success"), episode("s2", "success"), episode("f1", "failure")]);
  assert.equal(induced.kind, "draft");
  if (induced.kind !== "draft") return;

  const proposal = mapSkillDraft(induced.draft, { commandId: "skill:original-submit", issuedAt: at, risk: "low", hypothesis: "preserve rows", requiredVerifiers: [] });
  assert.ok(proposal.ok);

  for (const command of proposal.value) assert.ok((await board.apply(command)).ok);

  const versionId = "skill:original-legacy-version";

  assert.ok((await board.apply({ type: "commit_asset", commandId: "skill:original-commit", issuedAt: at, proposalId: induced.draft.id, versionId, schemaVersion: 1,
    content: { kind: "learned_skill", schemaVersion: 1, workspaceId: skillPaths.workspaceId, experienceDigest: "original-experiences", sourceOpportunityId: "opportunity:original", draft: induced.draft } })).ok);
  const management = createSkillDailyManagement(skillCtx), withdrawn = await management.withdraw(versionId);
  assert.ok(withdrawn.ok);
  assert.equal(withdrawn.status, "withdrawn");
  assert.deepEqual((await waitFor("skill_archive_withdrawal_committed")).sourceRefs, [versionId, `skill-withdraw:${versionId}`]);
  const beforeRepeat = runtime.owner.snapshot().wakeSequence, repeated = await management.withdraw(versionId);
  assert.ok(repeated.ok);
  assert.equal(repeated.status, "already_withdrawn");
  assert.equal(runtime.owner.snapshot().wakeSequence, beforeRepeat);
  assert.equal(existsSync(runtimeScopePaths(homeRoot, ctx.cwd).directory), false, "the unrelated caller directory never gains a learning owner");
  assert.deepEqual(stderr, []);
  assert.equal(seen.has("normal_entry"), false);
  assert.equal(seen.has("normal_task_source_committed"), false);
});
