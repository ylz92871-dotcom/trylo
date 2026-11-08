// Explicit diagnostics from the current skill source/review, process adapters,
// and v1/v2 funding paths. New codes require review here, never prefix trust.
const KNOWN_FAILURE_CODES = new Set([
  "cancelled",
  // Canonical source and bounded context projection.
  "hermes_experience_budget_invalid", "hermes_experience_limit", "hermes_source_journal_unavailable",
  "hermes_source_context_budget_invalid", "hermes_context_budget_invalid", "hermes_context_shape_invalid", "skill_checkpoint_read_only",
  // Native review lifecycle and validated receipt contract.
  "hermes_review_deadline_invalid", "hermes_review_timeout", "hermes_review_execution_failed", "hermes_review_execution_incomplete",
  "hermes_review_invalid_preparation", "hermes_review_invalid_receipts", "hermes_review_invalid_release", "hermes_review_invalid_reply",
  "hermes_review_not_found", "hermes_review_pending_not_confirmed", "hermes_review_pending_payload_mismatch",
  "hermes_review_pending_unavailable", "hermes_review_prompt_unavailable", "hermes_review_release_failed",
  "hermes_review_tool_failed", "hermes_review_unrelated_proposals", "hermes_review_wrong_store", "hermes_review_state_save_failed",
  // Node worker/client and its one fixed native persistence failure.
  "hermes_compat_cancelled_unknown", "hermes_compat_timeout_unknown", "hermes_profile_invalid",
  "hermes_shadow_failed", "hermes_shadow_unavailable", "hermes_shadow_execution_failed", "hermes_learning_state_corrupt",
  "hermes_worker_closed", "hermes_worker_failed", "hermes_worker_operation_failed", "hermes_worker_output_limit",
  "hermes_worker_pipe_failed", "hermes_worker_protocol_failed", "hermes_worker_start_failed", "hermes_worker_timeout",
  // Existing native context/explicit read adapter vocabularies.
  "hermes_context_invalid", "hermes_context_unknown_operation", "hermes_usage_invalid", "hermes_usage_not_recorded",
  "hermes_version_unavailable", "hermes_native_context_unavailable", "hermes_native_context_timeout", "hermes_native_context_output_limit",
  "hermes_explicit_unavailable", "hermes_explicit_invalid", "hermes_explicit_not_available", "hermes_explicit_metadata_invalid",
  "hermes_explicit_content_limit", "hermes_explicit_timeout", "hermes_explicit_output_limit", "hermes_skill_usage_unavailable",
  // Current runtime connection and fixed failure projections.
  "hermes_runtime_unavailable", "hermes_skill_control_unavailable", "hermes_skill_source_missing", "hermes_skill_source_unavailable",
  "skill_provider_configuration_unavailable", "skill_provider_credential_unavailable", "skill_learning_worker_failed",
  // Only actual central/legacy grant reasons that can reach the skill wrappers.
  "learning_aborted", "learning_allowance_exhausted", "learning_call_already_reserved",
  "learning_grant_conflict", "learning_grant_exhausted", "learning_grant_not_found", "learning_grant_closed",
  "learning_grant_unsettled", "learning_grant_scope_mismatch", "learning_grant_capacity",
  "learning_issue_not_found", "learning_issue_not_focused", "learning_issue_conflict", "learning_claim_active", "learning_claim_conflict",
  "skill_learning_inactive", "skill_learning_invalid_usage", "skill_learning_prompt_limit",
]);

/** Diagnostics cross the learner boundary as fixed vocabulary, never raw provider text. */
export function skillFailureCode(error: unknown, fallback: string): string {
  // Worker transport also carries fixed uppercase native persistence codes.
  const code = error instanceof Error && typeof error.message === "string" ? error.message.toLowerCase() : undefined;
  return code !== undefined && KNOWN_FAILURE_CODES.has(code) ? code : fallback;
}
