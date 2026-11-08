import assert from "node:assert/strict";
import test from "node:test";
import { candidate } from "../../../../../../tooling/testing/fixtures.js";
import type { ToolGapDraft } from "../../../../../../tooling/contract/types.js";
import { ADAPTER_ALLOWED_COMMAND_TYPES } from "../../../../../../integration/contract/rejection.js";
import {
  jobAdmission,
  packageAdmission,
  tamper,
} from "../../../../../../integration/testing/fixtures.js";
import { mapToolCandidate } from "./package.js";
import { mapToolGap } from "./job.js";

const gap: ToolGapDraft = {
  gapId: "gap-1",
  kind: "tool_not_found",
  observationIds: ["obs-1", "obs-2"],
  capability: "pdf",
  taskFamily: "docs",
  criticality: "high",
  repeatCount: 3,
  fallbackAvailable: false,
  explanation: "连续三次找不到 pdf 表格读取能力",
};

test("a gap becomes a deduplicated tool job bound to one of its observations", () => {
  const result = mapToolGap(gap, jobAdmission());

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const command = result.value[0];
  if (command?.type !== "enqueue_job") {
    throw new Error("expected enqueue_job");
  }

  assert.equal(command.job.domain, "tool");
  assert.equal(command.job.observationId, "obs-1");
  assert.equal(command.job.dedupeKey, "gap:gap-1");
  assert.equal(command.job.scope, "docs");
});

test("a gap cannot reference an observation outside its own set", () => {
  const result = mapToolGap(gap, jobAdmission({ observationId: "obs-9" }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "missing_observation_link");
  }
});

test("a gap without observations is rejected", () => {
  const result = mapToolGap(tamper(gap, { observationIds: [] }), jobAdmission());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "missing_observation_link");
  }
});

test("a candidate becomes a tool_package proposal that declares its authorities", () => {
  const result = mapToolCandidate(
    candidate({ candidateId: "cand-mit", name: "pdf-lint" }),
    packageAdmission(),
  );

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const command = result.value[0];
  if (command?.type !== "submit_proposal") {
    throw new Error("expected submit_proposal");
  }

  assert.equal(command.proposal.assetKind, "tool_package");
  assert.equal(command.proposal.domain, "tool");
  assert.equal(command.proposal.proposalId, "tool_package:cand-mit");
  assert.equal(command.proposal.risk, "low");
  assert.deepEqual(command.proposal.requestedAuthorities, ["fs.read"]);
  assert.deepEqual(command.proposal.requiredVerifiers, ["tool_validation_pipeline"]);
  assert.equal(
    (ADAPTER_ALLOWED_COMMAND_TYPES as readonly string[]).includes(command.type),
    true,
  );
});

test("a required permission that is not declared for approval is rejected", () => {
  const result = mapToolCandidate(
    candidate({ candidateId: "cand-mit", name: "pdf-lint", requiredPermissions: ["fs.read", "net"] }),
    packageAdmission({ requestedAuthorities: ["fs.read"] }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "authority_mismatch");
  }
});

test("rejected licenses never become board proposals", () => {
  for (const license of ["GPL-3.0-only", "AGPL-3.0-only", "UNKNOWN", "SOURCE-AVAILABLE"]) {
    const result = mapToolCandidate(
      tamper(candidate({ candidateId: "cand-bad", name: "pdf-lint" }), { licenseSpdx: license }),
      packageAdmission(),
    );

    assert.equal(result.ok, false, license);

    if (!result.ok) {
      assert.equal(result.reason, "license_not_admissible", license);
    }
  }
});

test("open/ material and impersonations stay out of the board", () => {
  const fromOpen = mapToolCandidate(
    candidate({ candidateId: "cand-open", name: "pdf-lint", fromOpenTree: true }),
    packageAdmission(),
  );

  assert.equal(fromOpen.ok, false);

  if (!fromOpen.ok) {
    assert.equal(fromOpen.reason, "reference_only_source");
  }

  const fake = mapToolCandidate(
    candidate({
      candidateId: "cand-fake",
      name: "pdf-lint",
      officialIdentity: "impersonation_risk",
    }),
    packageAdmission(),
  );

  assert.equal(fake.ok, false);

  if (!fake.ok) {
    assert.equal(fake.reason, "identity_unverified");
  }
});
