import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamRepresentationControl } from "./team-representation-control.js";
import { inspectTeamRepresentation } from "../protocol/team-representation.js";

const clear = "### Intent\n核对范围\n### Veto\nnone\n### User questions\nnone\n### Representation notes\n检查完毕";
test("one frozen Person cannot clear another member's pending scope or veto", async () => {
  const gate = new TeamRepresentationControl(inspectTeamRepresentation, () => [], () => {}, ["first", "second"]);
  gate.inputQueued("person", "first"); gate.inputQueued("person", "second");
  await gate.observe("person", clear, "first");
  assert.equal(gate.failure("worker")?.code, "team_representation_pending");
  await gate.observe("person", clear.replace("### Veto\nnone", "### Veto\n禁止写入"), "second");
  await gate.observe("person", clear, "first");
  assert.equal(gate.failure("worker")?.code, "team_representation_held");
  gate.inputQueued("person", "second");
  await gate.observe("person", clear, "second");
  assert.equal(gate.failure("worker"), undefined);
});
