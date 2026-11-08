import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createFileBoardStore } from "../../../../../adapters/learning-store/file-event-store.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { BoardCommand } from "../../../../control/commands.js";
import { emptyBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createCollaborationControl } from "../control/index.js";
import type { CollaborationBoardPort } from "../domain/contracts.js";
import { createPersonalAgentCollaboration } from "../personal-agent/service.js";
import { createPersonalAgentTools } from "./personal-agent-tools.js";
import { createFileCollaborationBoard } from "./board-port.js";

const NOW = "2026-11-03T12:00:00.000Z", scope = "workspace:pa-tool-limits";
const unexpected = (): never => { throw new Error("Decision validation must not invoke a capability, library, feedback or model"); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

test("PA report preserves supplied facts and refs while adding one exact host source, with an explicit capacity boundary", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-pa-report-admission-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-pa-report-admission-"));
    await rm(root, { recursive: true, force: true });
  });
  let state = emptyBoardState();
  const originalBoard = createFileCollaborationBoard(root), commands: BoardCommand[] = [], signals: (AbortSignal | undefined)[] = [];
  const board: CollaborationBoardPort = { load: originalBoard.load, async apply(command, signal) {
    commands.push(command);
    signals.push(signal);
    const result = await originalBoard.apply(command, signal);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "pa-source-contract" });
  const service = createPersonalAgentCollaboration({ control, scope, turnId: "turn:source-contract",
    currentResources: unexpected, allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 1200 } });
  const sourceAddress = "host-source:exact-original-session-and-turn";
  const base = { service, scope, turnId: "turn:source-contract", capability: unexpected, library: unexpected, feedback: unexpected };
  const tools = createPersonalAgentTools({ ...base, sourceAddress }), legacy = createPersonalAgentTools(base);
  const properties = tools.snapshot().find(binding => binding.name === "collaboration_report")!.parameters.properties;

  assert.ok(object(properties) && object(properties.evidenceRefs));
  assert.deepEqual(properties.evidenceRefs.anyOf, [{ maxItems: 31 }, { maxItems: 32, contains: { const: sourceAddress } }]);
  const oldProperties = legacy.snapshot().find(binding => binding.name === "collaboration_report")!.parameters.properties;

  assert.ok(object(oldProperties) && object(oldProperties.evidenceRefs));
  assert.equal(oldProperties.evidenceRefs.anyOf, undefined);
  const facts = ["The original requirement remains unresolved."], hypotheses = ["The known condition may not cover it."];
  const invoke = (port: ReturnType<typeof createPersonalAgentTools>, id: string, evidenceRefs: string[]) => port.execute({
    name: "collaboration_report", toolCallId: id, arguments: { problemKey: id, facts, hypotheses, evidenceRefs } }, new AbortController().signal);
  const refs31 = Array.from({ length: 31 }, (_, index) => `evidence:${index}`);

  assert.equal((await invoke(tools, "report:source-added", refs31)).outcome, "result");
  const saved = state.learningIssues!.at(-1)!.reports[0]!;

  assert.deepEqual(saved.facts, facts);
  assert.deepEqual(saved.hypotheses, hypotheses);
  assert.deepEqual(saved.evidenceRefs, [...refs31, sourceAddress]);
  assert.equal(refs31.length, 31);
  const before = state.sequence, refs32 = [...refs31, "evidence:31"];
  const full = await invoke(tools, "report:source-capacity", refs32);
  assert.equal(full.outcome, "error");

  if (full.outcome === "error") assert.equal(full.code, "collaboration_report_source_capacity");

  assert.equal(state.sequence, before);
  assert.equal(refs32.length, 32);
  const includesAddress = [sourceAddress, ...refs31];

  assert.equal((await invoke(tools, "report:source-already-present", includesAddress)).outcome, "result");
  assert.deepEqual(state.learningIssues!.at(-1)!.reports[0]!.evidenceRefs, includesAddress);
  assert.equal((await invoke(legacy, "report:legacy-source-unchanged", refs32)).outcome, "result");
  assert.deepEqual(state.learningIssues!.at(-1)!.reports[0]!.evidenceRefs, refs32);
  const invalidSource = createPersonalAgentTools({ ...base, sourceAddress: "" });
  const invalid = await invoke(invalidSource, "report:invalid-host-source", []);
  assert.equal(invalid.outcome, "error");

  if (invalid.outcome === "error") assert.equal(invalid.code, "collaboration_report_source_address_invalid");

  const durableBefore = await originalBoard.load();
  assert.ok(durableBefore.ok);
  const commandCount = commands.length, reportId = "report:cancelled-during-writer-admission", controller = new AbortController();
  const originalAction = { kind: "report" as const, scope, problemKey: reportId,
    report: { reportId, source: { teamRunId: base.turnId, taskId: base.turnId, memberId: "personal_agent" },
      facts, evidenceRefs: [sourceAddress], hypotheses }, issueId: `learning-issue:${contentHashOf([scope, reportId])}` };
  const expectedCommand: BoardCommand = { type: "coordinate_learning", issuedAt: NOW, action: originalAction,
    commandId: `central-learning:${contentHashOf(originalAction)}` };
  const reportBinding = tools.snapshot().find(binding => binding.name === "collaboration_report")!;

  assert.equal(reportBinding.needsApproval, false);
  assert.equal(reportBinding.sideEffect, "read_only");
  const holder = createFileBoardStore(root);
  assert.ok("apply" in holder);

  try {
    assert.equal(controller.signal.aborted, false);
    let settled = false;
    const pending = tools.execute({ name: "collaboration_report", toolCallId: reportId,
      arguments: { problemKey: reportId, facts, hypotheses, evidenceRefs: [] } }, controller.signal)
      .then(result => {
        settled = true;
        return result;
      });

    // The local adapter queue has yielded; the real shared writer remains held.
    await setImmediate();
    assert.equal(settled, false, "the original report must wait for shared writer admission");
    assert.equal(commands.length, commandCount + 1);
    assert.deepEqual(commands.at(-1), expectedCommand);
    assert.equal(signals.at(-1), controller.signal);
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.outcome, "result");

    if (aborted.outcome === "result") assert.deepEqual(JSON.parse(aborted.output), { ok: false, reason: "learning_aborted" });

    const durableAfter = await originalBoard.load();
    assert.ok(durableAfter.ok);
    assert.equal(durableAfter.state.sequence, durableBefore.state.sequence);
    assert.deepEqual(durableAfter.state.learningIssues, durableBefore.state.learningIssues);
    assert.deepEqual(durableAfter.state.appliedCommands, durableBefore.state.appliedCommands);
    assert.equal(commands.length, commandCount + 1);
    assert.deepEqual(commands.at(-1), expectedCommand);
    assert.deepEqual(tools.snapshot().find(binding => binding.name === "collaboration_report"), reportBinding);
  } finally { await holder.close(); }
});

test("PA decision schema and preflight match central reason/reference limits and accept their exact boundary", async () => {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "pa-limits" });
  const report = await control.report({ scope, problemKey: "handoff", report: { reportId: "report:limits",
    source: { teamRunId: "team:limits", taskId: "task:limits", memberId: "worker" }, facts: ["The source reference was missing."], evidenceRefs: [] } });
  assert.ok(report.ok);
  const service = createPersonalAgentCollaboration({ control, scope, turnId: "turn:limits", currentResources: async () => ({ view: {}, revision: "resource:1" }),
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 1200 } });
  const tools = createPersonalAgentTools({ service, scope, turnId: "turn:limits", capability: unexpected, library: unexpected, feedback: unexpected });
  const args = async (): Promise<JsonObject> => { const inspected = await service.inspect();
  assert.ok(inspected.ok);
    return { inspectionId: inspected.inspectionId, issueId: report.issue.issueId, expectedRevision: state.learningIssues![0]!.revision,
      decision: "ordinary_execution", reason: "Existing scheduling handles this issue.", sourceRefs: ["report:limits"] }; };
  const before = state.sequence;

  for (const patch of [{ reason: "r".repeat(1001) }, { sourceRefs: ["r".repeat(513)] },
    { sourceRefs: ["report:limits", "report:limits"] }, { sourceRefs: Array.from({ length: 33 }, (_, i) => `source:${i}`) }]) {
    const result = await tools.execute({ name: "collaboration_decide", toolCallId: "invalid:limits", arguments: { ...await args(), ...patch } }, new AbortController().signal);
    assert.equal(result.outcome, "error", "invalid lengths must fail at the advertised tool boundary, not return a central generic failure");
    if (result.outcome === "error") assert.match(result.message, patch.reason === undefined ? /sourceRefs.*32.*512.*unique/i : /reason.*1000/i);
    assert.equal(state.sequence, before);
  }

  const binding = tools.snapshot().find(b => b.name === "collaboration_decide")!;
  const fields = binding.parameters.properties;
  assert.ok(object(fields));
  assert.ok(object(fields.reason));
  assert.equal(fields.reason.maxLength, 1000);
  assert.ok(object(fields.sourceRefs));
  assert.equal(fields.sourceRefs.minItems, 0);
  assert.equal(fields.sourceRefs.maxItems, 32);
  assert.equal(fields.sourceRefs.uniqueItems, true);
  assert.ok(object(fields.sourceRefs.items));
  assert.equal(fields.sourceRefs.items.maxLength, 512);
  const accepted = await tools.execute({ name: "collaboration_decide", toolCallId: "valid:limits",
    arguments: { ...await args(), reason: "r".repeat(1000), sourceRefs: ["s".repeat(512)] } }, new AbortController().signal);

  assert.equal(accepted.outcome, "result");
  assert.equal(state.learningIssues![0]!.decision.kind, "ordinary_execution");
  const decided = state.learningIssues![0]!.decision;
  assert.notEqual(decided.kind, "unreviewed");
  assert.equal(decided.reason.length, 1000);
  assert.equal(decided.sourceRefs[0]!.length, 512);
  const noReferences = await tools.execute({ name: "collaboration_decide", toolCallId: "valid:empty-references",
    arguments: { ...await args(), sourceRefs: [] } }, new AbortController().signal);

  assert.equal(noReferences.outcome, "result");
  assert.notEqual(state.learningIssues![0]!.decision.kind, "unreviewed");
  const final = state.learningIssues![0]!.decision;
  assert.deepEqual(final.sourceRefs, []);
});

test("feedback tool advertises the canonical contract and diagnoses the real missing-source payload before its original entrypoint", async () => {
  let state = emptyBoardState();
  const accepted: unknown[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const service = createPersonalAgentCollaboration({ control: createCollaborationControl({ board, now: () => NOW, ownerId: "feedback-contract" }),
    scope, turnId: "turn:feedback", currentResources: async () => ({ view: {}, revision: "resource:1" }),
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 1200 } });
  const tools = createPersonalAgentTools({ service, scope, turnId: "turn:feedback", capability: unexpected, library: unexpected,
    feedback: async input => {
      accepted.push(input);
      return { ok: true };
    } });
  // Real failure: pa-partial-feedback.json supplied these fields but omitted sourceRefs.
  const realPayload: JsonObject = { receiptId: "deepseek-20261103-02-partial-delivery-feedback",
    usageReceiptId: "experience-dispatch:5bbd743e4ae0f37a990150b3843ff73beb7561c6c73ff2290478b286eb7b4cb2",
    owner: { experienceKey: "expert:75a4413c-8ac7-4078-be41-8aca5b39c2ce", kind: "expert" },
    versionIds: ["collaboration-experience-version:c427de57a2177a88d29879b9675a40429bc736541f6b4af5abebcf47a1808961"], outcome: "uncertain",
    summary: "Producer produced improved-handoff.json but failed with token_budget_exhausted before completion. Consumer independently validated source contract and unchanged orders artifact (2 orders, 2000 CNY), confirming partial_delivery_validated. Artifact is bounded/usable but does not establish improvement or full producer success; pipeline remains incomplete." };
  const schema = tools.snapshot().find(item => item.name === "collaboration_feedback")!.parameters.properties;

  assert.ok(object(schema) && object(schema.feedback));
  assert.deepEqual(schema.feedback.required, ["receiptId", "owner", "versionIds", "usageReceiptId", "summary", "sourceRefs", "outcome"]);
  assert.ok(object(schema.feedback.properties));
  assert.ok(object(schema.feedback.properties.summary));
  assert.equal(schema.feedback.properties.summary.maxLength, 1500);
  assert.ok(object(schema.feedback.properties.sourceRefs));
  assert.equal(schema.feedback.properties.sourceRefs.minItems, 1);
  const invoke = (feedback: JsonObject) => tools.execute({ name: "collaboration_feedback", toolCallId: "feedback:contract", arguments: { feedback } }, new AbortController().signal);
  const missing = await invoke(realPayload);
  assert.equal(missing.outcome, "error");

  if (missing.outcome === "error") assert.match(missing.message, /feedback\.sourceRefs.*1-32 unique references.*1-512/i);

  assert.equal(accepted.length, 0);
  const valid = { ...realPayload, sourceRefs: ["file:consumer-summary.json"] };

  assert.equal((await invoke(valid)).outcome, "result");
  assert.deepEqual(accepted, [valid]);

  for (const patch of [{ summary: "x".repeat(1501) }, { sourceRefs: [] }, { sourceRefs: ["same", "same"] }, { versionIds: [] }, { outcome: "completed" }, { owner: { kind: "expert", experienceKey: " " } }]) {
    const denied = await invoke({ ...valid, ...patch });
    assert.equal(denied.outcome, "error");
  }

  assert.equal(accepted.length, 1);
  assert.equal((await invoke({ ...valid, summary: "s".repeat(1500), sourceRefs: ["s".repeat(512)] })).outcome, "result");
});
