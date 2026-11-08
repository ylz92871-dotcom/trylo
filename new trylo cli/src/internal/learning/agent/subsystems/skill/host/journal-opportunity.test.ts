import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createNdjsonSessionStore } from "../../../../../adapters/session-store/ndjson.js";
import { createJournalSkillOpportunity, opportunityFromTranscript } from "./journal-opportunity.js";
import { journalExperienceFixture } from "./journal-experience-fixture.js";
import type { HermesSkillOpportunity } from "../contracts.js";

test("native learning capsule retains a later correction and the failed operation", () => {
  const opportunity = opportunityFromTranscript({ workspaceRoot: "D:/synthetic", sessionId: "session", turnId: "turn", transcript: [
    { sequence: 0, kind: "user", text: "Summarize rows by group." },
    { sequence: 1, kind: "tool_call", toolCallId: "call", name: "run_shell", arguments: { command: "node report --legacy-order" } },
    { sequence: 2, kind: "tool_result", toolCallId: "call", name: "run_shell", output: "Failure: empty groups were omitted.", truncated: false, outcome: "failed" },
    { sequence: 3, kind: "user", text: "Correction: retain empty groups and use the supplied group order." },
    { sequence: 4, kind: "assistant_reasoning", blockId: "private", text: "Private reasoning must not enter the capsule.", redacted: false },
    { sequence: 5, kind: "assistant_text", blockId: "answer", text: "The corrected output retains empty groups." },
  ] });

  // Assert at the real native boundary, including its sanitization/truncation.
  assert.equal("hasPendingReview" in (opportunity.flags ?? {}), false, "the execution journal cannot assert a separate review is absent");
  const require = createRequire(import.meta.url);
  const { buildEvidenceCapsule } = require("../vendor/legacy/learning-loop/evidence-builder.js");
  const { capsule } = buildEvidenceCapsule({ ...opportunity, triggerKind: opportunity.trigger });

  assert.equal(capsule.taskGoal, "Summarize rows by group.");
  assert.match(capsule.learnRequest, /Correction: retain empty groups/);
  assert.match(capsule.workflow[0].title, /node report --legacy-order/);
  assert.equal(capsule.workflow[0].status, "failed");
  assert.ok(capsule.verification.some((value: string) => value.includes("Failure: empty groups were omitted.")));
  assert.doesNotMatch(JSON.stringify(capsule), /Private reasoning/);
});

test("source terminal facts and lesson text share canonical recovery and never include an unanswered operation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-skill-snapshot-"));
  const filename = path.join(root, "session.ndjson"), store = createNdjsonSessionStore({ path: filename });
  const sessionId = "snapshot-session", workspaceId = "snapshot-workspace", at = "2026-11-03T20:00:00.000Z";

  try {
    assert.ok((await store.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "fixture",
      model: "fixture", toolCatalogHash: "tools", workspaceId } })).ok);
    const append = async (type: "transcript_item" | "terminal", turnId: string, payload: Parameters<typeof store.append>[0]["payload"]) => {
      assert.ok((await store.append({ type, sessionId, turnId, at, payload })).ok);
    };

    await append("transcript_item", "earlier", { sequence: 0, kind: "user", text: "An earlier task" });
    await append("terminal", "earlier", { reason: "completed", finishReason: "stop" });
    await append("transcript_item", "current", { sequence: 1, kind: "user", text: "Current task with observed failure" });
    await append("transcript_item", "current", { sequence: 2, kind: "tool_call", toolCallId: "unanswered", name: "read_file", arguments: { path: "must-not-learn.txt" } });
    await append("transcript_item", "current", { sequence: 3, kind: "assistant_text", blockId: "current-answer", text: "The current task failed before its read returned." });
    await append("terminal", "current", { reason: "failed", finishReason: "provider_error" });
    const source = createJournalSkillOpportunity({ workspaceRoot: "D:/synthetic", workspaceId,
      sessions: () => [{ id: sessionId, path: filename, modifiedAtMs: 1 }] });
    const result = await source(new AbortController().signal);
    assert.ok(result);
    assert.equal(result.turnId, "current");
    assert.equal(result.taskGoal, "Current task with observed failure");
    assert.match(result.resultSummary ?? "", /current task failed/);
    assert.deepEqual(result.experience?.terminal, { reason: "failed", finishReason: "provider_error", sessionUnresolvedEffects: 0,
      interpretation: "Canonical execution terminal, not a verifier verdict or proof of a good deliverable." });
    assert.doesNotMatch(JSON.stringify(result), /must-not-learn\.txt/);
    assert.deepEqual(result.fileHints, []);
  } finally {
    await store.release();
    assert.ok(path.basename(root).startsWith("trylo-skill-snapshot-"));
    await rm(root, { recursive: true, force: true });
  }
});

test("a real canonical journal preserves repeated-id read and repair occurrence details in source order", async t => {
  const fx = await journalExperienceFixture(t), turn = fx.turn("reused-id");
  await turn.start("Read the old input, repair it, and read the new input.");
  await turn.item({ kind: "tool_call", toolCallId: "reused", name: "read_file", arguments: { path: "before.json" } });
  await turn.item({ kind: "tool_result", toolCallId: "reused", name: "read_file", output: "Old input", outcome: "succeeded", truncated: false });
  await turn.item({ kind: "tool_call", toolCallId: "reused", name: "run_shell", arguments: { command: "node repair-report" } });
  await turn.item({ kind: "tool_result", toolCallId: "reused", name: "run_shell", output: "Repair still omitted an empty group", outcome: "failed", truncated: false });
  await turn.item({ kind: "tool_call", toolCallId: "reused", name: "read_file", arguments: { path: "after.json" } });
  await turn.item({ kind: "tool_result", toolCallId: "reused", name: "read_file", output: "New input", outcome: "succeeded", truncated: false });
  await turn.terminal();
  const opportunity = await fx.opportunity("reused-id");
  assert.ok(opportunity);
  assert.deepEqual(opportunity.events, [
    { category: "read", title: "read_file: before.json", status: "done" },
    { category: "command", title: "run_shell: node repair-report", status: "failed" },
    { category: "read", title: "read_file: after.json", status: "done" },
  ]);
  assert.deepEqual(opportunity.verification, ["Observed failed run_shell: Repair still omitted an empty group"]);
});

test("source events and failure evidence never claim a future or differently named call", () => {
  const opportunity = opportunityFromTranscript({ workspaceRoot: "workspace", sessionId: "session", turnId: "turn", transcript: [
    { kind: "tool_result", sequence: 0, toolCallId: "future", name: "run_shell", output: "UNISSUED_FAILURE", outcome: "failed", truncated: false },
    { kind: "tool_call", sequence: 1, toolCallId: "future", name: "run_shell", arguments: { command: "future command" } },
    { kind: "tool_call", sequence: 2, toolCallId: "mismatch", name: "read_file", arguments: { path: "issued.txt" } },
    { kind: "tool_result", sequence: 3, toolCallId: "mismatch", name: "run_shell", output: "WRONG_OPERATION_FAILURE", outcome: "failed", truncated: false },
  ] });

  assert.deepEqual(opportunity.events, []);
  assert.deepEqual(opportunity.verification, []);
  assert.deepEqual(opportunity.experience?.messages, []);
});

test("selected terminal recovery and native evidence identity cannot absorb later issues or settlements", async t => {
  const fx = await journalExperienceFixture(t), at = "2026-11-03T20:00:00.000Z";
  // These are the canonical progress records: effect identity is turn + key,
  // and a later reconciliation names the original turn it actually settles.
  const effect = async (type: "effect_issued" | "effect_committed", turnId: string, key: string) => {
    assert.ok((await fx.store.append({ type, sessionId: fx.sessionId, turnId, at, payload: { key } })).ok);
  };
  const unresolved = (source: HermesSkillOpportunity) => {
    const terminal = source.experience?.terminal;
    assert.ok(terminal !== null && typeof terminal === "object" && "sessionUnresolvedEffects" in terminal);
    return terminal.sessionUnresolvedEffects;
  };
  // Use the real native evidence identity/processed-state path, with no model,
  // network or native provider transport in this source contract.
  const require = createRequire(import.meta.url);
  const { createNativeReviewBackend } = require("./review-backend.mjs");
  const data = new Map<string, unknown>();
  const storage = { root: "terminal-prefix-contract", memento: {
    get: (key: string, fallback: unknown) => data.has(key) ? structuredClone(data.get(key)) : fallback,
    update: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
  }, compatibility: { pendingList: async () => ({ ok: true, pending: [] }) } };
  const backend = createNativeReviewBackend({ loadPrompt: async () => ({ success: true, prompt: "Official guidance fixture." }) });
  const rememberIdentity = async (source: HermesSkillOpportunity, reviewId: string) => {
    const prepared = await backend.begin(storage, source, reviewId);
    assert.equal(prepared.status, "ready");
    try {
      const result = await backend.finish(storage, reviewId, { status: "completed", answer: "No durable improvement.", proposals: [], toolFailures: 0 });
      assert.equal(result.status, "no_learning");
      assert.equal(backend.seen(storage, source), true);
    } finally { backend.release(storage, reviewId); }
  };
  const clean = fx.turn("old-clean");
  await clean.start("The old task reached its own terminal.");
  await clean.terminal();
  const oldClean = await fx.opportunity("old-clean");
  assert.ok(oldClean);
  assert.equal(unresolved(oldClean), 0);
  await rememberIdentity(oldClean, "clean-review");
  const later = fx.turn("later-unresolved");
  await later.start("A later task has its own unresolved operation.");
  await effect("effect_issued", "later-unresolved", "tool:later-call");
  await later.terminal();
  const afterLaterIssue = await fx.opportunity("old-clean"), laterSource = await fx.opportunity("later-unresolved");

  assert.ok(afterLaterIssue && laterSource);
  assert.equal(unresolved(laterSource), 1);
  assert.deepEqual(afterLaterIssue, oldClean);
  assert.equal(backend.seen(storage, afterLaterIssue), true, "the real native evidence hash is unchanged");
  await effect("effect_committed", "later-unresolved", "tool:later-call");
  const pending = fx.turn("old-unresolved");
  await pending.start("This task was unresolved at its selected terminal.");
  await effect("effect_issued", "old-unresolved", "tool:old-call");
  await pending.terminal();
  const oldPending = await fx.opportunity("old-unresolved");
  assert.ok(oldPending);
  assert.equal(unresolved(oldPending), 1);
  await rememberIdentity(oldPending, "pending-review");
  await effect("effect_committed", "old-unresolved", "tool:old-call");
  const settled = fx.turn("after-reconciliation");
  await settled.start("The original operation has now actually settled.");
  await settled.terminal();
  const afterSettlement = await fx.opportunity("old-unresolved"), settledSource = await fx.opportunity("after-reconciliation");

  assert.ok(afterSettlement && settledSource);
  assert.equal(unresolved(settledSource), 0);
  assert.deepEqual(afterSettlement, oldPending);
  assert.equal(backend.seen(storage, afterSettlement), true, "late settlement cannot rewrite the old evidence hash");
});
