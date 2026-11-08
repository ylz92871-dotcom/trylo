import assert from "node:assert/strict";
import test from "node:test";
import { proposalAdmission, workflowDraft } from "../testing/fixtures.js";
import { mapWorkflowDraft } from "./workflow.js";

test("workflow task family cannot be relabeled by the proposal scope", () => {
  const result = mapWorkflowDraft(
    workflowDraft(),
    proposalAdmission({ scope: "task_family:database-export" }),
  );
  assert.equal(result.ok, false);
});

test("workflow proposal rejects smuggled authority in its recovery body", () => {
  const result = mapWorkflowDraft(
    { ...workflowDraft(), failureFallback: [{ on: "skip_approval", goto: "repro" }] },
    proposalAdmission({ scope: "task_family:ts-unit-fix" }),
  );
  assert.equal(result.ok, false);
});

test("workflow proposal rejects a stale command binding", () => {
  const original = workflowDraft();
  const result = mapWorkflowDraft(
    { ...original, id: "another-draft" },
    proposalAdmission({ scope: "task_family:ts-unit-fix" }),
  );
  assert.equal(result.ok, false);
});

test("workflow proposal rejects a directly constructed unusable budget", () => {
  const original = workflowDraft();
  const result = mapWorkflowDraft(
    { ...original, budget: { ...original.budget, maxWallMs: -1 } },
    proposalAdmission({ scope: "task_family:ts-unit-fix" }),
  );
  assert.equal(result.ok, false);
});
