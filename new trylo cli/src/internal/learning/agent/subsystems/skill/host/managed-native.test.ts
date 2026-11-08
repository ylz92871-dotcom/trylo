import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { createRewardV2BoardPort } from "../../../../../integration/reward/v2-board-port.js";
import { createCentralSkillExecution } from "../../../../../integration/central-learning/skill-adapter.js";
import type { CentralFundedStage } from "../../../../../integration/central-learning/contracts.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import { createSkillCoordination } from "../control/coordination.js";
import { skillLifecycleProjection } from "../control/lifecycle.js";
import { projectSkillCentralFeedbackChanges } from "../control/central-feedback-changes.js";
import { readOrganizationNativeFeedbackUnit } from "../../../../../integration/central-learning/organization-feedback-sources.js";
import { createSkillReviewProcess } from "../review-process.js";
import { skillProposalReceipts } from "../proposal-receipts.js";
import { createHermesNodeClient, type HermesToolProfile } from "./client.js";
import { createHermesManagedSkillRuntime } from "./managed-runtime.js";
import { hermesReviewBackend } from "./review-client.js";
import { hermesProfileClientFor } from "./mcp-client-for.js";
import { hermesProfileRegistry } from "./mcp-profile.js";
import { bindHermesNormalContext } from "./normal-binding.js";
import { createHermesNativeContext } from "./native-context.js";
import { createSkillLifecycleObserver } from "./lifecycle-observer.js";
import { journalExperienceFixture } from "./journal-experience-fixture.js";
import { fileURLToPath } from "node:url";
import { recoverSessionRecordView } from "../../../../../adapters/session-store/ndjson.js";

const signal = () => new AbortController().signal;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Platform/native integration, zero provider calls. Only the model transport is
 * scripted: real worker review, official prompt, actual MCP stage, native
 * hash-checked approval, normal discovery/read, native counters and Board facts. */
test("managed Hermes native proposal approves and is later loaded with source-bound facts", { timeout: 90_000 }, async t => {
  const rootParent = process.env.TRYLO_HERMES_NATIVE_FIXTURE_PARENT;
  const f = await journalExperienceFixture(t, { ...(rootParent === undefined ? {} : { rootParent }),
    preserveRoot: process.env.TRYLO_HERMES_NATIVE_KEEP_FIXTURE === "1" });

  t.diagnostic(`Native fixture journal: ${f.filename}`);
  const scope = path.dirname(f.filename), at = "2026-11-03T20:00:00.000Z";
  const boardRoot = path.join(scope, "learning", "board");
  const board = { load: () => createBoardReader(boardRoot).load(),
    apply: (command: BoardCommand) => withBoardWriter(boardRoot, store => store.apply(command)) };
  let serial = 0;
  const act = async (action: CoordinationAction) => {
    const result = await board.apply({ type: "coordinate_learning", commandId: `native-contract:${++serial}`, issuedAt: at, action });
    assert.ok(result.ok);
    return result.state;
  };
  const sourceTurn = f.turn("source");
  await sourceTurn.start("Keep the observed release manifest repair reusable.");
  await sourceTurn.item({ kind: "assistant_text", blockId: "observed-source-answer",
    text: "Observed release procedure: read the package manifest and preserve its declared version when preparing release notes." });
  await sourceTurn.terminal();
  const sourceJournal = await f.store.readRecords();
  assert.ok(sourceJournal.ok, JSON.stringify(sourceJournal));
  const recoveredSource = recoverSessionRecordView(sourceJournal.view);
  assert.ok(recoveredSource.ok, JSON.stringify(recoveredSource));
  const coordination = createSkillCoordination({ board, scope, ownerId: "native-managed-contract", now: () => at });
  const reported = await coordination.report({ sourceRef: "journal:native-source", taskId: "source", versionId: f.sessionId,
    facts: ["Isolated canonical source fixture; no claim of learned effectiveness."], evidenceRefs: ["journal:native-source"] });

  assert.ok(reported.ok);
  let state = await act({ kind: "decide", issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Bounded native protocol contract", sourceRefs: ["journal:native-source"] });

  state = await act({ kind: "open_budget", expectedSequence: state.sequence,
    budget: { schemaVersion: 1, budgetId: "root:native-contract", scope, unit: "total_model_tokens",
      limits: { tokens: 100000, calls: 4, steps: 4 }, authorizationRef: "contract:explicit-root" } });
  const client = createHermesNodeClient({ nodeBinary: process.execPath, env: process.env, storageRoot: path.join(scope, "native-store"),
    nextId: () => `native-${++serial}` });

  t.after(() => client.close());
  const review = createSkillReviewProcess(hermesReviewBackend(client)), name = "central-release-manifest-contract";
  const content = `---\nname: ${name}\ndescription: Preserve the observed package version when preparing release notes.\n---\n\n# Release manifest\n\nRead package.json before writing release notes. Keep its declared version. If the manifest is missing, stop and request the authoritative version.\n`;
  const runtime = createHermesManagedSkillRuntime({ scope, coordination,
    read: source => f.opportunity(source.turnId), seen: (opportunity, runSignal) => client.review("seen", { opportunity }, runSignal),
    review: (opportunity, work) => review(opportunity, async (prompt, runSignal) => {
      assert.match(prompt, /OBSERVED TASK EXPERIENCE/);
      assert.ok(prompt.length <= work.grant.allowance.maxPromptChars);
      const profile = await client.profile("learning", runSignal);
      const args = { action: "create", name, content };
      const output = await nativeTool(profile, "skill_propose", args, scope);
      const transcript: Transcript = [{ kind: "tool_call", sequence: 0, toolCallId: "scripted-model-stage",
        name: `mcp__${profile.name}__skill_propose`, arguments: args },
      { kind: "tool_result", sequence: 1, toolCallId: "scripted-model-stage", name: `mcp__${profile.name}__skill_propose`,
        outcome: "succeeded", truncated: false, output }];
      const proposals = skillProposalReceipts(transcript);
      assert.equal(proposals.length, 1, output);

      return { answer: "Native proposal staged; approval is required.", proposals, status: "completed", toolFailures: 0 };
    }, work.signal) });
  const adapter = createCentralSkillExecution({ board, scope, runtime });
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 100000,
    maxCalls: 2, maxSteps: 2, maxPromptChars: 100000 };
  const prepared = await adapter.prepare({ issueId: reported.issue.issueId, authorizedAllowance: allowance }, signal());

  assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  state = await act({ kind: "fund", domain: "skill", issueId: reported.issue.issueId,
    expectedRevision: state.learningIssues![0]!.revision, grantId: prepared.source.grantId, budgetId: "root:native-contract",
    expectedSequence: state.sequence, authorizationRef: "contract:native-grant", planRef: "contract:native-plan", allowance });
  const input: CentralFundedStage = { issueId: reported.issue.issueId, grantId: prepared.source.grantId,
    expectedIssueRevision: state.learningIssues![0]!.revision, stageRef: prepared.stageRef, policyRef: prepared.policyRef,
    sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
  const dispatched = await adapter.dispatch(input, signal());
  assert.ok(dispatched.ok, JSON.stringify(dispatched));
  const proposal = await adapter.observe(input, signal());
  assert.equal(proposal.outcome, "qualified");
  const pendingId = proposal.resultRefs[0]!.slice("hermes-pending:skills:".length);
  const detail = await client.compatibility("pendingDetail", { subsystem: "skills", id: pendingId });

  assert.ok(record(detail) && detail.ok === true && record(detail.detail));
  const expectedHash = detail.detail.payloadHash;
  assert.equal(typeof expectedHash, "string");

  if (typeof expectedHash !== "string") throw new Error("native_hash_missing");

  const approved = await client.compatibility("pendingApply", { subsystem: "skills", id: pendingId, expectedHash });

  assert.ok(record(approved) && approved.ok === true, JSON.stringify(approved));
  const reward = createRewardV2BoardPort(boardRoot, () => true);
  const observer = createSkillLifecycleObserver({ board, enabled: () => true, append: (revision, draft) => reward.append(revision, draft) });

  await observer.recordApproval({ pendingId, expectedHash, reply: approved, at: "2026-11-03T20:00:01.000Z" });
  const normal = await client.profile("normal");
  // The bounded regression control runs an actual original normal-server.py
  // copied to a separate temp directory. It never edits the live source tree.
  const regressionReadScript = process.env.TRYLO_HERMES_NATIVE_READ_SCRIPT;
  const readProfile = regressionReadScript === undefined ? normal : { ...normal, args: [regressionReadScript, ...normal.args.slice(1)] };
  const warnings: string[] = [];
  const binding = bindHermesNormalContext(normal, createHermesNativeContext({ pythonBinary: normal.command,
    capabilitiesDir: fileURLToPath(new URL("../vendor/legacy/hermes-capabilities/", import.meta.url)),
    hermesHome: normal.env.HERMES_HOME!, env: process.env, warn: code => warnings.push(code) }), code => warnings.push(code));

  assert.match(await binding.promptForTools(normal.allowedTools), new RegExp(name));
  const output = await nativeTool(readProfile, "skill_view", { name }, scope, binding.observer);
  const readTurn = f.turn("later-read", "2026-11-03T20:00:02.000Z");
  await readTurn.start("Prepare release notes with the learned procedure.");
  await readTurn.item({ kind: "tool_call", toolCallId: "actual-normal-load", name: `mcp__${normal.name}__skill_view`, arguments: { name } });
  await readTurn.item({ kind: "tool_result", toolCallId: "actual-normal-load", name: `mcp__${normal.name}__skill_view`,
    outcome: "succeeded", truncated: false, output });
  await readTurn.terminal();
  let captured: Parameters<typeof observer.recordTaskLoads>[0] | undefined;

  await f.opportunity("later-read", ({ transcript, records }) => { captured = { scope, sessionId: f.sessionId, turnId: "later-read", transcript, records }; });
  assert.ok(captured);
  await observer.recordTaskLoads(captured);
  const loaded = await board.load();
  assert.ok(loaded.ok);
  const projected = skillLifecycleProjection(loaded.state, scope, input.issueId);
  assert.ok(projected);
  assert.deepEqual(projected.records.map(row => row.kind), ["native_approved", "instruction_loaded"]);
  assert.equal(projected.records[1]!.instructionHash, projected.records[0]!.instructionHash);
  assert.equal(projected.records[1]!.turnId, "later-read");
  assert.deepEqual(warnings, []);
  const changes = projectSkillCentralFeedbackChanges(loaded.state, { scope }).filter(change => change.issueId === input.issueId);

  assert.equal(changes.length, 2);

  for (const change of changes) {
    const row: JsonObject | undefined = projected.records.find(item => item.sourceRef === change.factRef);
    assert.ok(row);
    const original: JsonObject = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "sourceRef" && key !== "interpretation"));
    const unit = readOrganizationNativeFeedbackUnit(projected, change);
    assert.equal(unit.kind, "found");

    if (unit.kind !== "found") throw new Error("Original native lifecycle unit was not selected");

    assert.deepEqual(unit.payload, original);
    assert.deepEqual(new Set(unit.sourceRefs), new Set([change.factRef, change.unitRef, String(row.grantId), String(row.jobId),
      ...(row.kind === "instruction_loaded" ? [String(row.approvalRef)] : [])]));
    assert.equal(unit.sourceRefs.includes(projected.sourceRef), false);
  }

  await observer.recordTaskLoads(captured);
  const retried = await board.load();
  assert.ok(retried.ok);
  assert.equal(retried.state.sequence, loaded.state.sequence);
});

async function nativeTool(profile: HermesToolProfile, leaf: string, args: JsonObject, cwd: string,
  observer?: Parameters<typeof hermesProfileClientFor>[2]) {
  const resolved = await hermesProfileRegistry(profile).resolve(profile.name);
  assert.ok(resolved.ok);
  const opened = hermesProfileClientFor(profile, undefined, observer)(resolved.value.entry, cwd);
  assert.ok(opened.ok);

  try {
    assert.ok((await opened.client.connect()).ok);
    const tools = await opened.client.listTools();
    assert.ok(tools.ok);
    const qualifiedName = `mcp__${profile.name}__${leaf}`;
    assert.ok(tools.value.some(tool => tool.qualifiedName === qualifiedName));
    const result = await opened.client.callTool({ qualifiedName, arguments: args, timeoutMs: 30000 });
    assert.ok(result.ok && result.outcome.outcome === "result", JSON.stringify(result));
    return result.outcome.output;
  } finally { await opened.client.close(); }
}
