import type { BoardState } from "./state.js";

export type MethodUsage = {
  readonly turns: ReadonlySet<string>;
  readonly helpedTurns: ReadonlySet<string>;
  readonly lastSeq: number;
  readonly lastUsedAt: string;
};

/** Count real opportunities per turn/version; silence contributes no helped verdict. */
export function methodUsageOf(state: BoardState): ReadonlyMap<string, MethodUsage> {
  const usage = new Map<string, {
    turns: Set<string>; helpedTurns: Set<string>; lastSeq: number; lastUsedAt: string;
  }>();

  state.fieldings.forEach((item, index) => {
    const current = usage.get(item.versionId) ?? {
      turns: new Set<string>(), helpedTurns: new Set<string>(), lastSeq: 0, lastUsedAt: item.recordedAt,
    };

    current.turns.add(item.turnId);
    current.lastSeq = index + 1;
    current.lastUsedAt = item.recordedAt;
    usage.set(item.versionId, current);
  });

  for (const item of state.feedbacks) {
    const prior = usage.get(item.versionId);
    if (item.helped && prior?.turns.has(item.turnId)) {
      prior.helpedTurns.add(item.turnId);
    }
  }

  return usage;
}
