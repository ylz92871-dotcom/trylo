import assert from "node:assert/strict";
import test from "node:test";
import {
  observationAdmission,
  rollbackAdmission,
  suspendAdmission,
  tamper,
} from "../../../../../../integration/testing/fixtures.js";
import { mapToolRollback, mapToolSuspend } from "./lifecycle.js";
import { mapToolObservation } from "./observation.js";
import { observation } from "../../../../../../tooling/testing/fixtures.js";

test("suspend and rollback stay requests and never change state locally", () => {
  const suspended = mapToolSuspend(
    { kind: "request_suspend", packageVersionId: "pkg:pdf-lint:1.0.0", reason: "连续失败" },
    suspendAdmission(),
  );

  assert.equal(suspended.ok, true);

  if (suspended.ok) {
    const command = suspended.value[0];
    assert.equal(command?.type, "suspend");
    if (command?.type === "suspend") {
      assert.equal(command.breakerReason, "连续失败");
      assert.equal(command.proposalId, "tool_package:cand-mit");
    }
  }

  const rolled = mapToolRollback(
    { kind: "request_rollback", packageVersionId: "pkg:pdf-lint:1.0.0", reason: "效果回退" },
    rollbackAdmission(),
  );

  assert.equal(rolled.ok, true);

  if (rolled.ok) {
    const command = rolled.value[0];
    assert.equal(command?.type, "rollback");
  }
});

test("a request whose admitted version does not match is rejected", () => {
  const result = mapToolSuspend(
    { kind: "request_suspend", packageVersionId: "pkg:pdf-lint:1.0.0", reason: "连续失败" },
    suspendAdmission({ packageVersionId: "pkg:other:2.0.0" }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "missing_version_link");
  }
});

test("rollback must explicitly require the board-owned previous version", () => {
  const result = mapToolRollback(
    { kind: "request_rollback", packageVersionId: "pkg:pdf-lint:1.0.0", reason: "效果回退" },
    tamper(rollbackAdmission(), { requireBoardPreviousVersion: false }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "invalid_admission");
  }
});

test("a tool observation needs admitted scope, outcome, causal refs and privacy class", () => {
  const result = mapToolObservation(
    observation({ observationId: "obs-1", kind: "tool_failure" }),
    observationAdmission(),
  );

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.scope, "docs");
  assert.equal(result.value.outcome, "failed");
  assert.equal(result.value.occurredAt, "2026-09-12T00:00:00Z");
  assert.deepEqual(result.value.causalRefs, ["turn-1"]);
  assert.equal(result.value.reason, undefined);
});

test("contradictory observation and outcome is rejected", () => {
  const result = mapToolObservation(
    observation({ observationId: "obs-1", kind: "success" }),
    observationAdmission({ outcome: "failed" }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "observation_contradiction");
  }
});

test("an observation with no causal reference cannot be consumed by learning", () => {
  const result = mapToolObservation(
    observation({ observationId: "obs-1", kind: "tool_not_found" }),
    observationAdmission({ causalRefs: [] }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "missing_causal_refs");
  }
});

test("an unparseable recordedAt is rejected rather than passed through", () => {
  const result = mapToolObservation(
    observation({ observationId: "obs-1", kind: "tool_not_found", recordedAt: "yesterday" }),
    observationAdmission(),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "invalid_timestamp");
  }
});
