import assert from "node:assert/strict";
import { test } from "node:test";
import { reduce } from "../domain/reduce.js";
import { initialState } from "../domain/state.js";
import { replayCommitted } from "./replay.js";

test("committed effect keys are skipped on replay", () => {
  const start = {
    type: "start_turn" as const,
    eventId: "e1",
    sessionId: "ses-1",
    turnId: "trn-1",
    correlationId: "cor-1",
    text: "hi",
  };
  const opened = reduce(initialState(), start);

  assert.equal(opened.ok, true);

  if (!opened.ok) {
    return;
  }

  const keys = new Set(opened.commands.map((command) => command.idempotencyKey));
  const replayed = replayCommitted([start], keys);

  assert.equal(replayed.skipped.length > 0, true);
  assert.equal(replayed.state.phase, "turning");
});
