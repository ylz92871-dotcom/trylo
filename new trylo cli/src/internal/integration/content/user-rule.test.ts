import assert from "node:assert/strict";
import test from "node:test";
import type { SubmitProposalCommand } from "../../learning/control/commands.js";
import { mapContentDraft } from "../content/index.js";
import type { ContentProposalAdmission } from "../contract/admission.js";
import { ADAPTER_ALLOWED_COMMAND_TYPES } from "../contract/rejection.js";
import { proposalAdmission, tamper, userRuleDraft } from "../testing/fixtures.js";
import { mapUserRuleDraft } from "../content/user-rule.js";

function firstCommand(commands: readonly SubmitProposalCommand[]): SubmitProposalCommand {
  assert.equal(commands.length, 1);
  const command = commands[0];
  if (command === undefined) {
    throw new Error("no command produced");
  }
  return command;
}

test("a user rule draft becomes a board proposal and nothing else", () => {
  const result = mapUserRuleDraft(userRuleDraft(), proposalAdmission());

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const command = firstCommand(result.value);

  assert.equal(command.proposal.assetKind, "user_rule");
  assert.equal(command.proposal.domain, "user");
  assert.equal(command.proposal.scope, "task_family:ts-unit-fix");
  assert.equal(command.proposal.source, "user_explicit");
  assert.equal(command.proposal.candidateRef.startsWith("user_rule:"), true);
  assert.deepEqual(command.proposal.requestedAuthorities, []);
  assert.equal("lifecycle" in command.proposal, false);
  assert.equal(command.commandId, "cmd-1");
});

test("a user rule draft never requests authority", () => {
  const draft = tamper(userRuleDraft(), { permissionClaim: true, capabilityGranted: "read_only" });
  const result = mapUserRuleDraft(draft, proposalAdmission());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "authority_claim_present");
  }
});

test("permission language in the source text blocks admission", () => {
  const draft = tamper(userRuleDraft(), { permissionLanguageDetected: true });
  const result = mapUserRuleDraft(draft, proposalAdmission());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "permission_language_present");
  }
});

test("a promoted draft is not a draft anymore", () => {
  const draft = tamper(userRuleDraft(), { status: "active" });
  const result = mapUserRuleDraft(draft, proposalAdmission());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_a_draft");
  }
});

test("a draft that carries its own scope rejects a second scope source", () => {
  const result = mapUserRuleDraft(userRuleDraft(), {
    ...proposalAdmission(),
    scope: "project:repo-a",
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "invalid_admission");
  }
});

test("missing or malformed admission fields fail closed", () => {
  const cases: Array<[string, ContentProposalAdmission]> = [
    ["empty commandId", proposalAdmission({ commandId: "" })],
    ["unparseable issuedAt", proposalAdmission({ issuedAt: "yesterday" })],
    ["unknown risk", tamper(proposalAdmission(), { risk: "catastrophic" })],
    ["empty hypothesis", proposalAdmission({ hypothesis: "  " })],
    ["verifiers not an array", tamper(proposalAdmission(), { requiredVerifiers: "unit_test" })],
  ];
  for (const [name, admission] of cases) {
    const result = mapUserRuleDraft(userRuleDraft(), admission);
    assert.equal(result.ok, false, name);
  }
});

test("unknown draft kinds are rejected by the dispatcher", () => {
  const result = mapContentDraft(tamper(userRuleDraft(), { kind: "mystery" }), proposalAdmission());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unknown_source_kind");
  }
});

test("every command an adapter can emit is on the allow list", () => {
  const result = mapUserRuleDraft(userRuleDraft(), proposalAdmission());

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  for (const command of result.value) {
    assert.equal(
      (ADAPTER_ALLOWED_COMMAND_TYPES as readonly string[]).includes(command.type),
      true,
      command.type,
    );
    assert.notEqual(command.type, "activate");
    assert.notEqual(command.type, "record_approval_decision");
  }
});
