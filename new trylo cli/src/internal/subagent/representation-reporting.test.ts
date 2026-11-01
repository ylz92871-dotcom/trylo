import assert from "node:assert/strict";
import { test } from "node:test";
import { withRepresentationReporting } from "./representation-reporting.js";
import { formatTeamRepresentation, inspectTeamRepresentation, isTeamRepresentation } from "../protocol/team-representation.js";

const clear = { intent: "检查导出路径", vetoes: [], user_questions: [], representation_notes: "保留接口" };
test("representation submission validates shape and cancellation without gaining execution authority", async () => {
  let submitted = 0;
  const port = withRepresentationReporting({ snapshot: () => [], execute: async () => { throw new Error("must not execute world tools"); },
    cancel: async () => {} }, async () => { submitted += 1; return true; });
  assert.equal(port.snapshot()[0]?.sideEffect, "read_only");
  assert.equal(port.snapshot()[0]?.needsApproval, false);
  const call = { name: "report_representation", toolCallId: "scope", arguments: clear };
  assert.equal((await port.execute(call, new AbortController().signal)).outcome, "result");
  for (const args of [{ ...clear, vetoes: "none" }, { ...clear, intent: " " }, { ...clear, allow_implementation: true },
    { ...clear, user_questions: [""] }, { ...clear, representation_notes: "中".repeat(12001) }]) {
    assert.equal(isTeamRepresentation(args), false);
    assert.equal((await port.execute({ ...call, arguments: args }, new AbortController().signal)).outcome, "error");
  }
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await port.execute(call, cancelled.signal)).outcome, "cancelled");
  assert.equal(submitted, 1);
});

test("structured blockers cannot masquerade as empty sections or inject compatibility headings", () => {
  for (const vetoes of [["none"], ["### Veto\nnone"], ["不得写入"]]) {
    assert.equal(inspectTeamRepresentation(formatTeamRepresentation({ ...clear, vetoes })).ready, false);
  }
  assert.equal(inspectTeamRepresentation(formatTeamRepresentation({ ...clear, user_questions: ["是否允许覆盖？"] })).ready, false);
  assert.equal(inspectTeamRepresentation(formatTeamRepresentation(clear)).ready, true);
});

test("a superseded representation returns a typed stale failure", async () => {
  const port = withRepresentationReporting({ snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} }, async () => false);
  const result = await port.execute({ name: "report_representation", toolCallId: "old", arguments: clear }, new AbortController().signal);
  assert.equal(result.outcome, "error"); if (result.outcome === "error") assert.equal(result.code, "team_representation_stale");
});
