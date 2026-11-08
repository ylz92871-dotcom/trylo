import assert from "node:assert/strict";
import test from "node:test";
import { skillTaskReport } from "./task-report.js";

test("a single later user input remains eligible when earlier turns loaded a skill", () => {
  const input = { sessionId: "session", turnId: "feedback", transcript: [{ kind: "user" as const, sequence: 4, text: "The exported rows are still missing an empty group." }] };

  assert.equal(skillTaskReport(input), undefined);
  const report = skillTaskReport({ ...input, historyLoadedSkills: ["table-export"] });

  assert.ok(report);
  assert.equal(report.versionId, "session");
  assert.equal(report.taskId, "feedback");
  assert.ok(report.facts.some(fact => fact.includes("Earlier successful skill loads in the same session: 1")));
  assert.ok(report.facts.every(fact => !fact.includes("missing an empty group")), "the sensor does not select a lesson from user text");
});

test("history alone creates no new task opportunity without new user input or tools", () => {
  assert.equal(skillTaskReport({ sessionId: "session", turnId: "empty", transcript: [], historyLoadedSkills: ["table-export"] }), undefined);
});

test("unverified human attribution qualifies transport facts without blocking procedural opportunities", () => {
  for (const userAttribution of ["unverified", "unknown", "not_recorded"] as const) {
    const report = skillTaskReport({ sessionId: "session", turnId: "mixed", userAttribution, transcript: [
      { kind: "user", sequence: 0, text: "PRIVATE_MIXED_TRANSPORT_TEXT" },
      { kind: "tool_call", sequence: 1, toolCallId: "read", name: "read_file", arguments: { path: "input.json" } },
      { kind: "tool_result", sequence: 2, toolCallId: "read", name: "read_file", outcome: "succeeded", truncated: false, output: "Observed input." },
    ] });

    assert.ok(report);
    assert.ok(report.facts.some(fact => fact.includes(`Current human attribution: ${userAttribution}.`)));
    assert.ok(report.facts.some(fact => fact.includes("This is a transport role")));
    assert.ok(report.facts.some(fact => fact.includes("Observed tool results: 1")));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_MIXED_TRANSPORT_TEXT/);
  }
});
