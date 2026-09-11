// Trylo Work — Work-domain state machine tests.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §3):
// covers the conversation / task state machines and the
// isChat → intent compatibility mapping.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canTransitionTurnState,
  intentFromIsChat,
  isTerminalTurnState,
  type WorkTurnState,
} from "../src/work-domain.js";

const NON_TERMINAL: readonly WorkTurnState[] = [
  "idle",
  "answering",
  "understanding",
  "planning",
  "executing",
  "awaiting_approval",
  "awaiting_input",
  "recovering",
  "verifying",
  "finalizing",
];

describe("intentFromIsChat", () => {
  it("maps true → conversation", () => {
    assert.equal(intentFromIsChat(true), "conversation");
  });
  it("maps false / undefined → task", () => {
    assert.equal(intentFromIsChat(false), "task");
    assert.equal(intentFromIsChat(undefined), "task");
  });
});

describe("conversation state machine (spec §3.1)", () => {
  it("answers and may reach a terminal without task phases", () => {
    assert.equal(canTransitionTurnState("conversation", "idle", "answering"), true);
    assert.equal(canTransitionTurnState("conversation", "answering", "final_answer"), true);
    assert.equal(canTransitionTurnState("conversation", "answering", "error"), true);
    assert.equal(canTransitionTurnState("conversation", "answering", "cancelled"), true);
  });
  it("must NOT enter the task machine", () => {
    for (const s of ["understanding", "executing", "verifying", "awaiting_approval"] as const) {
      assert.equal(
        canTransitionTurnState("conversation", "answering", s),
        false,
        `conversation must not reach ${s}`,
      );
    }
  });
  it("is absorbing once terminal", () => {
    assert.equal(canTransitionTurnState("conversation", "final_answer", "answering"), false);
  });
});

describe("task state machine (spec §3.2)", () => {
  it("executing parks / resumes on blockers", () => {
    assert.equal(canTransitionTurnState("task", "executing", "awaiting_approval"), true);
    assert.equal(canTransitionTurnState("task", "awaiting_approval", "executing"), true);
    assert.equal(canTransitionTurnState("task", "executing", "awaiting_input"), true);
    assert.equal(canTransitionTurnState("task", "awaiting_input", "executing"), true);
    assert.equal(canTransitionTurnState("task", "executing", "recovering"), true);
  });
  it("finalizes before terminal and never reopens after", () => {
    assert.equal(canTransitionTurnState("task", "finalizing", "final_answer"), true);
    assert.equal(canTransitionTurnState("task", "executing", "finalizing"), true);
    // A terminal is an absorbing target: once reached, the run
    // cannot go back to any non-terminal state (spec §3.3).
    assert.equal(canTransitionTurnState("task", "final_answer", "executing"), false);
    assert.equal(canTransitionTurnState("task", "final_answer", "error"), false);
  });
  it("a non-terminal state may reach a terminal state", () => {
    for (const from of NON_TERMINAL) {
      assert.equal(canTransitionTurnState("task", from, "error"), true, `${from}→error`);
      assert.equal(canTransitionTurnState("task", from, "cancelled"), true, `${from}→cancelled`);
    }
  });
});

describe("terminal detection", () => {
  it("identifies the three terminal presentation states", () => {
    assert.equal(isTerminalTurnState("final_answer"), true);
    assert.equal(isTerminalTurnState("error"), true);
    assert.equal(isTerminalTurnState("cancelled"), true);
    assert.equal(isTerminalTurnState("executing"), false);
  });
});