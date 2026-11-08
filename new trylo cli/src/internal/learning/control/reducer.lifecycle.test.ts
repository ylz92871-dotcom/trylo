import assert from "node:assert/strict";
import test from "node:test";
import {
  command,
  inferredDraft,
  passEvidence,
  proposalOf,
  resetIds,
  userRuleDraft,
} from "./fixtures.js";
import { reduce, reduceAll } from "./reducer.js";
import { emptyBoardState } from "./state.js";
import {
  ILLEGAL_TRANSITION_EXAMPLES,
  LEGAL_PROPOSAL_TRANSITIONS,
  expectedTo,
} from "./transitions.js";
import type { BoardCommand } from "./commands.js";
import type { ProposalLifecycle } from "./contracts.js";
import type { BoardState } from "./state.js";

test("every legal transition is reachable and applied", () => {
  resetIds();
  for (const rule of LEGAL_PROPOSAL_TRANSITIONS) {
    const reached = reach(rule.from);
    const result = applyRule(reached.state, reached, rule.command);
    assert.equal(result.ok, true, `${rule.from}->${rule.command}`);
    if (result.ok) {
      assert.equal(proposalOf(result.state, reached.proposalId).lifecycle, rule.to);
    }
  }
});

test("illegal transition table is complete against expectedTo", () => {
  for (const example of ILLEGAL_TRANSITION_EXAMPLES) {
    assert.notEqual(
      expectedTo(example.from, example.command),
      example.to,
      `${example.from} ${example.command} ${example.to}`,
    );
  }
});

test("illegal transitions fail closed without mutating sequence", () => {
  resetIds();
  for (const example of ILLEGAL_TRANSITION_EXAMPLES) {
    const reached = reach(example.from);
    const before = reached.state.sequence;
    const result = applyRule(reached.state, reached, example.command);

    assert.equal(result.ok, false, `${example.from}->${example.command} should fail`);

    if (!result.ok) {
      assert.equal(result.reason, "illegal_transition");
      assert.equal(result.state.sequence, before);
    }
  }
});

test("main inferred path draft to active", () => {
  resetIds();
  const reached = reach("active");
  assert.equal(proposalOf(reached.state, reached.proposalId).lifecycle, "active");
  const activation = reached.state.activations[0];
  assert.equal(activation?.pointer, "active");
  assert.equal(activation?.versionId, reached.versionId);
});

test("fast lane draft to validated to active", () => {
  resetIds();
  const reached = reach("validated");

  assert.equal(proposalOf(reached.state, reached.proposalId).lifecycle, "validated");
  const activated = applyRule(reached.state, reached, "activate");

  assert.equal(activated.ok, true);

  if (activated.ok) {
    assert.equal(proposalOf(activated.state, reached.proposalId).lifecycle, "active");
  }
});

test("reject from draft quarantined evaluating shadow awaiting_approval", () => {
  resetIds();
  for (const from of ["draft", "quarantined", "evaluating", "shadow", "awaiting_approval"] as const) {
    const reached = reach(from);
    const result = applyRule(reached.state, reached, "reject");
    assert.equal(result.ok, true, from);
    if (result.ok) {
      assert.equal(proposalOf(result.state, reached.proposalId).lifecycle, "rejected");
    }
  }
});

type Reached = {
  state: BoardState;
  proposalId: string;
  versionId: string;
  approvalId: string;
};

function reach(lifecycle: ProposalLifecycle): Reached {
  if (lifecycle === "validated" || lifecycle === "draft") {
    return reachExplicit(lifecycle);
  }

  if (lifecycle === "rejected") {
    const draft = reachExplicit("draft");
    const result = reduce(
      draft.state,
      command("reject", { proposalId: draft.proposalId, reason: "no" }),
    );

    assert.equal(result.ok, true);

    return { ...draft, state: result.ok ? result.state : draft.state };
  }

  if (lifecycle === "retired") {
    const suspended = reachInferred("suspended");
    const result = reduce(
      suspended.state,
      command("retire", { proposalId: suspended.proposalId }),
    );

    assert.equal(result.ok, true);

    return { ...suspended, state: result.ok ? result.state : suspended.state };
  }

  return reachInferred(lifecycle);
}

function reachExplicit(lifecycle: "draft" | "validated"): Reached {
  const draft = userRuleDraft();
  const versionId = `v-${draft.proposalId}`;
  const approvalId = `a-${draft.proposalId}`;
  const commands: BoardCommand[] = [command("submit_proposal", { proposal: draft })];

  if (lifecycle === "validated") {
    commands.push(command("fast_lane_validate", { proposalId: draft.proposalId }));
    commands.push(
      command("commit_asset", {
        proposalId: draft.proposalId,
        versionId,
        content: { text: "rule" },
        schemaVersion: 1,
      }),
    );
  }

  const result = reduceAll(emptyBoardState(), commands);

  assert.equal(result.ok, true);

  if (!result.ok) {
    throw new Error("reachExplicit failed");
  }

  return { state: result.state, proposalId: draft.proposalId, versionId, approvalId };
}

function reachInferred(lifecycle: ProposalLifecycle): Reached {
  const draft = inferredDraft();
  const versionId = `v-${draft.proposalId}`;
  const approvalId = `a-${draft.proposalId}`;
  const commands = [
    command("submit_proposal", { proposal: draft }),
    command("quarantine", { proposalId: draft.proposalId }),
    command("start_evaluation", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId,
      content: { text: "patch" },
      schemaVersion: 1,
    }),
    command("record_evidence", { evidence: passEvidence(draft.proposalId) }),
    command("enter_shadow", { proposalId: draft.proposalId, versionId }),
    command("request_approval", {
      proposalId: draft.proposalId,
      approvalId,
      action: "activate",
    }),
    command("record_approval_decision", { approvalId, status: "granted" }),
    command("activate", { proposalId: draft.proposalId, versionId }),
    command("suspend", { proposalId: draft.proposalId, breakerReason: "neg-delta" }),
    command("rollback", { proposalId: draft.proposalId, reason: "user" }),
  ];
  const cutoff = cutoffFor(lifecycle);
  const result = reduceAll(emptyBoardState(), commands.slice(0, cutoff));
  if (!result.ok) {
    throw new Error(`${lifecycle}: ${result.reason} ${result.detail}`);
  }

  return { state: result.state, proposalId: draft.proposalId, versionId, approvalId };
}

function cutoffFor(lifecycle: ProposalLifecycle): number {
  switch (lifecycle) {
    case "draft":
      return 1;
    case "quarantined":
      return 2;
    case "evaluating":
      return 5;
    case "shadow":
      return 6;
    case "awaiting_approval":
      return 8;
    case "active":
      return 9;
    case "suspended":
      return 10;
    case "rolled_back":
      return 11;
    case "retired":
      return 10;
    default:
      return 1;
  }
}

function applyRule(
  state: BoardState,
  reached: Reached,
  type: (typeof LEGAL_PROPOSAL_TRANSITIONS)[number]["command"],
): ReturnType<typeof reduce> {
  switch (type) {
    case "quarantine":
    case "start_evaluation":
      return reduce(state, command(type, { proposalId: reached.proposalId }));
    case "enter_shadow":
      return reduce(
        state,
        command("enter_shadow", {
          proposalId: reached.proposalId,
          versionId: reached.versionId,
        }),
      );
    case "request_approval":
      return reduce(
        state,
        command("request_approval", {
          proposalId: reached.proposalId,
          approvalId: reached.approvalId,
          action: "activate",
        }),
      );
    case "activate":
      return reduce(
        state,
        command("activate", {
          proposalId: reached.proposalId,
          versionId: reached.versionId,
        }),
      );
    case "reject":
      return reduce(
        state,
        command("reject", { proposalId: reached.proposalId, reason: "no" }),
      );
    case "fast_lane_validate":
      return reduce(
        state,
        command("fast_lane_validate", { proposalId: reached.proposalId }),
      );
    case "suspend":
      return reduce(
        state,
        command("suspend", {
          proposalId: reached.proposalId,
          breakerReason: "neg-delta",
        }),
      );
    case "resume":
    case "retire":
      return reduce(state, command(type, { proposalId: reached.proposalId }));
    case "rollback":
      return reduce(
        state,
        command("rollback", { proposalId: reached.proposalId, reason: "user" }),
      );
    default:
      return reduce(state, command("reject", { proposalId: reached.proposalId, reason: "x" }));
  }
}
