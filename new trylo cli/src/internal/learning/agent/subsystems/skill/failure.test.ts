import assert from "node:assert/strict";
import test from "node:test";
import { skillFailureCode } from "./failure.js";

test("registered source, native persistence and funding failures preserve their fixed diagnostics", () => {
  for (const code of ["hermes_source_journal_unavailable", "hermes_source_context_budget_invalid", "hermes_worker_timeout",
    "hermes_review_invalid_receipts", "hermes_compat_cancelled_unknown", "hermes_compat_timeout_unknown",
    "learning_aborted", "learning_grant_unsettled", "learning_claim_conflict", "skill_learning_invalid_usage",
    "skill_provider_credential_unavailable", "cancelled"]) {
    assert.equal(skillFailureCode(new Error(code), "hermes_runtime_unavailable"), code);
  }
  assert.equal(skillFailureCode(new Error("HERMES_LEARNING_STATE_CORRUPT"), "hermes_runtime_unavailable"), "hermes_learning_state_corrupt");
});

test("unknown messages never become diagnostics through a trusted-looking namespace or Error shape", () => {
  const fallback = "hermes_review_execution_failed";

  for (const message of ["hermes_secret_synthetic_private_value", "learning_secret_synthetic_private_value",
    "skill_secret_synthetic_private_value", "HERMES_SECRET_SYNTHETIC_PRIVATE_VALUE", "hermes_worker_timeout_synthetic_private_value",
    "hermes_worker_timeout\nsynthetic-private-value", "private endpoint credential=synthetic-private-value"]) {
    assert.equal(skillFailureCode(new Error(message), fallback), fallback);
  }

  for (const value of [undefined, null, "hermes_worker_timeout", { message: "hermes_worker_timeout" }, { code: "HERMES_LEARNING_STATE_CORRUPT" }]) {
    assert.equal(skillFailureCode(value, fallback), fallback);
  }
});
