import assert from "node:assert/strict";
import test from "node:test";
import type { BoardCommand, RecordRewardV2FactCommand } from "./commands.js";
import { methodPayloadHash, recoverMethodCommandIdentities } from "./method-replay.js";
import type { AppliedCommand, BoardState } from "./state.js";

const stateWith = (appliedCommands: readonly AppliedCommand[]): BoardState => ({
  sequence: appliedCommands.length, appliedCommands, proposals: [], assets: [], activations: [], evidence: [],
  approvals: [], jobs: [], tombstones: [], fieldings: [], feedbacks: [],
});
const reward = (commandId: string, value: number): RecordRewardV2FactCommand => ({
  type: "record_reward_v2_fact", commandId, issuedAt: "2026-11-05T00:00:00.000Z", expectedSequence: 0,
  fact: { id: `fact:${value}`, scope: "workspace:recovery", kind: "projection", algorithmVersion: "recovery-test",
    payloadJson: JSON.stringify({ value }) },
});

test("identity recovery leaves complete or empty state untouched without reading log commands", () => {
  const commands = new Proxy<BoardCommand[]>([], { get() { throw new Error("unnecessary log access"); } });
  for (const state of [stateWith([]), stateWith([{ commandId: "known", sequence: 1, payloadHash: "original" }])]) {
    assert.strictEqual(recoverMethodCommandIdentities(state, commands), state);
  }
});

test("identity recovery hashes only missing IDs and keeps the last log payload", () => {
  let unrelatedPayloadReads = 0;
  const unrelated: RecordRewardV2FactCommand = { ...reward("known", 0), get fact() {
    unrelatedPayloadReads++;
    return reward("known", 0).fact;
  } };
  const known = { commandId: "known", sequence: 1, payloadHash: "original" };
  const state = stateWith([known, { commandId: "missing", sequence: 2 }, { commandId: "absent", sequence: 3 }]);
  const last = reward("missing", 2);
  const recovered = recoverMethodCommandIdentities(state, [reward("missing", 1), unrelated, last]);

  assert.equal(unrelatedPayloadReads, 0);
  assert.strictEqual(recovered.appliedCommands[0], known);
  assert.equal(recovered.appliedCommands[1]?.payloadHash, methodPayloadHash(last));
  assert.strictEqual(recovered.appliedCommands[2], state.appliedCommands[2]);
  assert.equal(state.appliedCommands[1]?.payloadHash, undefined);
});

test("identity recovery preserves an unhashable last command instead of using its earlier payload", () => {
  const state = stateWith([{ commandId: "missing", sequence: 1 }]);
  const last: BoardCommand = { type: "tombstone", commandId: "missing", issuedAt: "2026-11-05T00:00:00.000Z",
    entityId: "asset:original", entityType: "asset", reason: "original log ordering" };
  const recovered = recoverMethodCommandIdentities(state, [reward("missing", 1), last]);
  assert.strictEqual(recovered.appliedCommands[0], state.appliedCommands[0]);
  assert.equal(recovered.appliedCommands[0]?.payloadHash, undefined);
});
