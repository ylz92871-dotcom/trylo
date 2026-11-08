import type { RecordLearningGrantFactCommand } from "./commands.js";
import type { BoardState } from "./state.js";
import { MAX_LEARNING_GRANT_FACTS } from "./grant-contract.js";
import { isLearningGrantDraft } from "./grant-parse.js";
import { advanceLearningGrant, learningGrantSnapshots } from "./grant-state.js";
import { fail, nextSeq, succeed, type ReduceResult } from "./result.js";

export function applyLearningGrantFact(state: BoardState, command: RecordLearningGrantFactCommand): ReduceResult {
  if (!isLearningGrantDraft(command.fact)) return fail(state, "invalid_learning_grant", command.commandId);

  const previous = state.learningGrantFacts ?? [];
  if (previous.length >= MAX_LEARNING_GRANT_FACTS) return fail(state, "learning_grant_capacity", command.fact.grantId);

  const snapshots = learningGrantSnapshots(previous);
  if (snapshots === undefined) return fail(state, "invalid_learning_grant", "invalid grant history");

  const next = advanceLearningGrant(snapshots.get(command.fact.grantId), command.fact);
  if (!next.ok) return fail(state, next.reason, command.fact.grantId);

  // Every admitted provider call keeps a durable settlement slot. Other grants
  // and close/open bookkeeping cannot consume that outstanding obligation.
  const unsettled = [...snapshots.values()].reduce((count, grant) => count
    + grant.reservations.filter(reservation => reservation.state === "reserved").length, 0);
  const after = unsettled + (command.fact.kind === "reserve" ? 1 : command.fact.kind === "settle" ? -1 : 0);
  if (MAX_LEARNING_GRANT_FACTS - previous.length - 1 < after) return fail(state, "learning_grant_capacity", command.fact.grantId);

  const sequence = nextSeq(state), fact = { ...command.fact, boardSequence: sequence };

  return succeed(state, command.commandId, [{ type: "learning_grant_fact_recorded", sequence, commandId: command.commandId,
    occurredAt: command.issuedAt, fact }], { learningGrantFacts: [...previous, fact] });
}
