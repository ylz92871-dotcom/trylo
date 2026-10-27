import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTeamRepresentation } from "./team-representation.js";

const result = (veto = "none", questions = "none") => `### Intent\n- explicit: preserve acceptance\n### Veto\n${veto}\n### User questions\n${questions}\n### Representation notes\nVerified intent.`;

test("a complete Person answer with no veto or open questions admits implementation", () => {
  for (const marker of ["none", "`none`", "无", ""]) assert.deepEqual(inspectTeamRepresentation(result(marker)), { ready: true });
});

test("unanswered, malformed, vetoed and clarification-bearing representation cannot admit a worker", () => {
  for (const output of ["", "looks good", result().replace("### Representation notes", "Notes"),
    result("Keep explicit.acceptance; proposed change deletes it"), result("none", "- Which export format?"),
    result("none", "`none`")]) assert.equal(inspectTeamRepresentation(output).ready, false);
});

test("last repeated heading wins, bold heading drift is accepted and refusal reasons stay bounded", () => {
  assert.equal(inspectTeamRepresentation(`${result()}\n## Veto\nDo not implement`).ready, false);
  assert.equal(inspectTeamRepresentation(result().replaceAll("### Veto", "### **Veto**")).ready, true);
  const held = inspectTeamRepresentation(result("x".repeat(1000)));
  assert.equal(held.ready, false);
  if (!held.ready) assert.ok(held.reason.length <= 300);
});
