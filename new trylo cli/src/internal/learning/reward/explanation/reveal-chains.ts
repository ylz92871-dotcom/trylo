/** Historical layout only. A current point label is not evidence of a past reveal. */
export type RevealOpportunity = {
  readonly unitId: string;
  readonly registeredAt: number;
  readonly revealedAt?: number;
};

export type RevealChainAssignment = { readonly unitId: string; readonly chainOrdinal: number };

export type RevealChainLayout = {
  readonly assignments: readonly RevealChainAssignment[];
  readonly chainCounts: readonly number[];
  readonly revealedCount: number;
  readonly pendingCount: number;
};

export const MAX_FEEDBACK_UNITS = 100000;

export function validateFeedbackPopulation(input: readonly unknown[]): void {
  if (!Array.isArray(input) || input.length > MAX_FEEDBACK_UNITS) throw new RangeError("feedback_population_capacity");
}

function opportunities(input: readonly RevealOpportunity[]): readonly RevealOpportunity[] {
  validateFeedbackPopulation(input);
  const ids = new Set<string>();
  let previous = 0;

  return input.map(unit => {
    if (typeof unit !== "object" || unit === null) throw new TypeError("feedback_unit_shape");

    const { unitId, registeredAt, revealedAt } = unit;

    if (typeof unitId !== "string" || unitId.length === 0 || unitId.length > 512 || ids.has(unitId)) {
      throw new TypeError("feedback_unit_identity");
    }

    if (!Number.isSafeInteger(registeredAt) || registeredAt <= previous) throw new RangeError("feedback_registration_order");

    if (revealedAt !== undefined && (!Number.isSafeInteger(revealedAt) || revealedAt < registeredAt)) {
      throw new RangeError("feedback_reveal_order");
    }

    previous = registeredAt;
    ids.add(unitId);

    return Object.freeze({ unitId, registeredAt, ...(revealedAt === undefined ? {} : { revealedAt }) });
  });
}

/** Birth order is part of the target: reject it when invalid instead of sorting it. */
export function allocateRevealChains(input: readonly RevealOpportunity[]): RevealChainLayout {
  const units = opportunities(input);
  const closes = units.flatMap((unit, index) => unit.revealedAt === undefined ? [] : [{ at: unit.revealedAt, index }])
    .sort((left, right) => left.at - right.at || left.index - right.index);
  const available: number[] = [];
  const assignments: RevealChainAssignment[] = [];
  const chainCounts: number[] = [];
  let availableHead = 0;
  let closeHead = 0;

  for (const unit of units) {
    // Future closes are present in this offline view, but cannot affect this birth.
    while (closeHead < closes.length && closes[closeHead]!.at < unit.registeredAt) {
      const closing = closes[closeHead++]!;
      const prior = assignments[closing.index];
      if (prior === undefined) throw new Error("feedback_chain_reveal_before_assignment");
      available.push(prior.chainOrdinal);
    }

    const reused = available[availableHead];
    const ordinal = reused ?? chainCounts.length + 1;

    if (reused === undefined) chainCounts.push(0);
    else availableHead += 1;

    chainCounts[ordinal - 1] = chainCounts[ordinal - 1]! + 1;
    assignments.push(Object.freeze({ unitId: unit.unitId, chainOrdinal: ordinal }));
  }

  // A close after the last birth still counts as revealed at this snapshot.
  const revealedCount = closes.length;

  return Object.freeze({ assignments: Object.freeze(assignments), chainCounts: Object.freeze(chainCounts),
    revealedCount, pendingCount: units.length - revealedCount });
}
