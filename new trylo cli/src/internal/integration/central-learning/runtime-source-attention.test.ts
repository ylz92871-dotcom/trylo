import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../learning/control/reducer.js";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { isCollaborationRuntimeReceipt } from "../../learning/control/collaboration-runtime-parse.js";
import { experienceOwnerFingerprint } from "../../learning/agent/subsystems/collaboration/experience/policy.js";
import type { ExperienceBoundaryReceipt } from "../../protocol/collaboration-experience.js";
import { buildCentralRuntimeRecord, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import type { CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import type { ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback.js";
import { createNativeExposureAttention } from "./runtime-source-attention.js";

const scope = "scope:attention", issueId = "issue:attention", at = "2026-11-05T00:00:00.000Z";
const versions = ["experience:attention:a", "experience:attention:b"];
const owner = { kind: "personal_agent" as const, experienceKey: "trylo.personal_agent.v1" };

type Query = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;

const query: Query = { subjects: [], sourceRefs: [] };

function apply(board: BoardState, command: BoardCommand): BoardState {
  const result = reduce(board, command);
  assert.ok(result.ok);
  return result.state;
}

function initialBoard(): BoardState {
  return apply(emptyBoardState(), { type: "coordinate_learning", commandId: "report:attention", issuedAt: at,
    action: { kind: "report", scope, issueId, problemKey: "attention", report: { reportId: "report:attention",
      source: { memberId: "personal_agent", taskId: "task:attention", teamRunId: "turn:attention" },
      facts: ["One original collaboration issue remains open."], evidenceRefs: [] } } });
}

function receipt(id: string, round: number, overrides: Partial<ExperienceBoundaryReceipt> = {}): ExperienceBoundaryReceipt {
  const value: ExperienceBoundaryReceipt = { schemaVersion: 1, receiptId: `receipt:attention:${id}`, phase: "loaded", scope,
    owner, ownerFingerprint: experienceOwnerFingerprint(owner), versionIds: versions, recordedAt: at,
    boundary: { executionId: "turn:attention", taskId: "task:attention", round, role: "personal_agent", configurationRef: "personal-agent:v1" },
    ...overrides };
  assert.ok(isCollaborationRuntimeReceipt(value));
  return value;
}

function notice(value: ExperienceBoundaryReceipt): ContentDomainFeedbackChange {
  return { domain: "collaboration", issueId, factRef: value.receiptId, revisionRef: value.receiptId,
    unitRef: versions[0]!, kind: "delivery", sourceRefs: [value.receiptId, versions[0]!] };
}

function withReceipts(board: BoardState, receipts: readonly ExperienceBoundaryReceipt[]): BoardState {
  return { ...board, collaborationRuntimeReceipts: receipts };
}

function acknowledge(board: BoardState, refs: readonly string[]): BoardState {
  const before = readCentralRuntimeRecords(board.rewardV2Facts ?? [], scope, board.sequence);
  const state = { ...before.state, consumedSourceRefs: [...new Set([...before.state.consumedSourceRefs, ...refs])] };
  const fact = buildCentralRuntimeRecord({ previousRef: before.stateRef, state, reason: "Original notice was delivered", sourceRefs: refs });
  return apply(board, { type: "record_reward_v2_fact", commandId: `rw2:${fact.id}`, issuedAt: fact.id,
    expectedSequence: board.sequence, fact });
}

test("same-episode PA attention requires original acknowledgement, preserves changed boundaries and keeps original receipt navigation unread", () => {
  const seed = initialBoard(), first = receipt("first", 1), second = receipt("second", 2), third = receipt("third", 3);
  const dispatch = receipt("first-dispatch", 1, { phase: "dispatched", boundary: { ...first.boundary, requestId: "request:dispatch" } });
  const receipts = [first, second, third, dispatch], changes = receipts.map(notice), firstRefs = [first.receiptId, versions[0]!];
  const original = withReceipts(seed, receipts), board = acknowledge(original, firstRefs);
  const before = canonicalJson({ original, board, changes, query });
  const attention = createNativeExposureAttention(board, scope, changes, query);

  assert.deepEqual(attention.changes, [changes[0], changes[3]], "an acknowledged load does not swallow the first dispatch");
  assert.deepEqual(createNativeExposureAttention(original, scope, changes, { ...query, sourceRefs: firstRefs }).changes, changes,
    "caller-known positions are not a persisted delivery acknowledgement");
  assert.deepEqual(createNativeExposureAttention(board, scope, changes).changes, changes);

  for (const refs of [[first.receiptId], [versions[0]!]]) {
    assert.deepEqual(createNativeExposureAttention(acknowledge(original, refs), scope, changes, query).changes, changes,
      "the first original revision and its unit both require acknowledgement");
  }

  const otherOwner = { ...owner, experienceKey: "trylo.personal_agent.other" };
  const changed: readonly [string, ExperienceBoundaryReceipt][] = [
    ["overlapping versions are not the complete same set", receipt("versions", 2, { versionIds: [versions[0]!, "experience:attention:c"] })],
    ["a subset is not the same version set", receipt("subset", 2, { versionIds: [versions[0]!] })],
    ["configuration changed", receipt("configuration", 2, { boundary: { ...second.boundary, configurationRef: "personal-agent:v2" } })],
    ["owner changed", receipt("owner", 2, { owner: otherOwner, ownerFingerprint: experienceOwnerFingerprint(otherOwner) })],
    ["task changed", receipt("task", 2, { boundary: { ...second.boundary, taskId: "task:other" } })],
    ["execution changed", receipt("execution", 2, { boundary: { ...second.boundary, executionId: "turn:other" } })],
    ["phase changed", dispatch],
    ["loaded has no configuration proof", receipt("missing-configuration", 2, { boundary: {
      executionId: second.boundary.executionId, taskId: second.boundary.taskId, round: 2, role: "personal_agent" } })],
  ];

  for (const [reason, next] of changed) {
    const ownChanges = [notice(first), notice(next)], ownBoard = acknowledge(withReceipts(seed, [first, next]), firstRefs);
    assert.deepEqual(createNativeExposureAttention(ownBoard, scope, ownChanges, query).changes, ownChanges, reason);
  }

  const reordered = receipt("reordered", 2, { versionIds: [...versions].reverse() });

  assert.deepEqual(createNativeExposureAttention(acknowledge(withReceipts(seed, [first, reordered]), firstRefs), scope,
    [notice(first), notice(reordered)], query).changes, [notice(first)], "version set order does not invent a new exposure boundary");

  const protectedChanges: readonly ContentDomainFeedbackChange[] = [
    { ...notice(second), kind: "quality" }, { ...notice(second), kind: "correction" },
    { ...notice(second), kind: "correction", factRef: "withdrawal:attention", revisionRef: "withdrawal:attention" },
    { ...notice(second), kind: "approval", factRef: "proposal:attention", revisionRef: "proposal:attention" },
  ];

  assert.deepEqual(createNativeExposureAttention(board, scope, protectedChanges, query).changes, protectedChanges);

  for (const [rounds, retained] of [[[1, 4, 3, 5], [1, 3, 5]], [[1, 4, 4, 5], [1, 4, 4, 5]]] as const) {
    const own = rounds.map((round, index) => receipt(`anomaly:${round}:${index}`, round));
    const ownBoard = acknowledge(withReceipts(seed, own), [own[0]!.receiptId, versions[0]!]);
    const result = createNativeExposureAttention(ownBoard, scope, own.map(notice), query);
    assert.deepEqual(result.changes.map(change => own.find(row => row.receiptId === change.factRef)!.boundary.round), retained,
      "backwards or duplicate rounds and all following notices remain visible");
  }

  const foreign = receipt("foreign", 1, { receiptId: first.receiptId, scope: "scope:foreign",
    boundary: { ...first.boundary, executionId: "turn:foreign" } });
  const mixed = { ...board, collaborationRuntimeReceipts: [...receipts, foreign] };

  assert.deepEqual(createNativeExposureAttention(mixed, scope, changes, query, [foreign.scope]).changes, attention.changes,
    "a compatible foreign receipt with the same ID cannot replace the issue's original-scope receipt");

  const index = attention.navigation([issueId])[0];
  assert.ok(index);
  assert.ok(isCentralUnreadNavigationMaterial(index));
  const chains = index.sourceRefs.map(ref => {
    const material = attention.read(ref);
    assert.ok(material);
    return { ref, material };
  });
  const load = chains.find(row => JSON.parse(row.material.text).phase === "loaded");
  assert.ok(load);

  for (const material of [index, ...chains.map(row => row.material)]) {
    assert.ok(isCentralUnreadNavigationMaterial(material));
    assert.ok(material.sourceRefs.every(ref => !receipts.some(row => row.receiptId === ref)), "navigation never acknowledges a later original receipt");
    assert.ok(material.sourceRefs.every(ref => ref.startsWith("central-runtime-native-catalog:chain:")));
  }

  const entries: readonly ContentDomainFeedbackChange[] = JSON.parse(load.material.text).entries;

  assert.deepEqual(entries.map(entry => entry.factRef), [first.receiptId, second.receiptId, third.receiptId]);
  const listening: Query = { ...query, purposes: [{ subject: { plane: "agent", domain: "collaboration", issueId },
    purpose: "Watch this original exposure chain", sourceRefs: [load.ref] }] };

  assert.deepEqual(createNativeExposureAttention(board, scope, changes, listening).changes, changes);
  const historyOnly = acknowledge(original, [...firstRefs, load.ref]);

  assert.deepEqual(createNativeExposureAttention(historyOnly, scope, changes, { ...query, sourceRefs: [load.ref] }).changes,
    attention.changes, "generic history and known references do not create an explicit listener");
  assert.equal(canonicalJson({ original, board, changes, query }), before, "attention does not mutate original Board/projector inputs");
});
