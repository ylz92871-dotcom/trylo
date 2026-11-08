/**
 * Continuing goals with a budget and a life of their own (WP21.3: C61).
 *
 * A goal outlives one turn: the user names an objective, the run pursues it
 * across turns, and the ending says *how* it ended. Four endings that must
 * never be confused:
 *
 * - `complete` — the objective is achieved and no required work remains.
 * - `blocked` — the same blocker recurred and the run is at an impasse.
 * - `paused_by_user` / `cancelled` — a person stopped it; the words stay so
 *   the next turn can resume them instead of reinventing them.
 * - `budget_exhausted` — tokens or time ran out. This is never success: a
 *   run that stops because the meter stopped must say so, not claim the
 *   objective is met because it is tired.
 *
 * Mechanical reuse of Codex `ext/goal` (`create/get/update_goal`, persistent
 * state, review exclusion, `token_budget`): the tool names and the
 * complete/blocked discipline are kept, the accounting is mapped onto Trylo's
 * own task facts, and the goal is never a learning scheduler — it owns no
 * retrieval, no reflection, no asset writes.
 */

export type GoalStatus =
  | "active"
  | "paused_by_user"
  | "paused_by_system"
  | "budget_exhausted"
  | "cancelled"
  | "complete"
  | "blocked";

export const GOAL_STATUSES: ReadonlyArray<GoalStatus> = [
  "active",
  "paused_by_user",
  "paused_by_system",
  "budget_exhausted",
  "cancelled",
  "complete",
  "blocked",
];

export type GoalRecord = {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly tokenBudget?: number;
  readonly tokensUsed: number;
  readonly createdAtTurn: string;
  readonly updatedAtTurn: string;
  /** Why the last transition happened, in the actor's own words. */
  readonly note?: string;
  readonly blockedReason?: string;
  readonly blockedRounds?: number;
  readonly usageUncertain?: true;
};

export type GoalTransition =
  | { readonly ok: true; readonly goal: GoalRecord }
  | { readonly ok: false; readonly code: GoalReject; readonly message: string };

export type GoalReject =
  | "no_goal"
  | "goal_exists"
  | "terminal"
  | "invalid_budget"
  | "empty_objective"
  | "not_blocked_by_repetition";

const MAX_OBJECTIVE_CHARS = 2000;

/** User-only objective edits retain accounting and never resume execution. */
export function editGoal(existing: GoalRecord | undefined, objective: string, atTurn: string, tokenBudget?: number): GoalTransition {
  if (existing === undefined) return { ok: false, code: "no_goal", message: "no goal exists to edit" };

  if (existing.status === "complete" || existing.status === "cancelled") {
    return { ok: false, code: "terminal", message: "terminal goals cannot be edited" };
  }

  const validated = createGoal(undefined, objective.trim(), atTurn, tokenBudget);
  if (!validated.ok) return validated;

  if (tokenBudget !== undefined && (tokenBudget < existing.tokensUsed || (existing.tokenBudget !== undefined && tokenBudget < existing.tokenBudget))) {
    return { ok: false, code: "invalid_budget", message: "editing cannot reduce the existing budget or erase usage" };
  }

  return { ok: true, goal: { ...existing, objective: validated.goal.objective,
    status: existing.status === "active" ? "paused_by_user" : existing.status,
    ...(tokenBudget === undefined ? {} : { tokenBudget }), updatedAtTurn: atTurn,
    blockedRounds: 0, blockedReason: "", note: "edited_by_user" } };
}

/** Guard for the complete v1 snapshot at a journal boundary. */
export function isGoalRecord(value: unknown): value is GoalRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const g = value as Record<string, unknown>;

  return typeof g.objective === "string" && g.objective.trim().length > 0 && g.objective.length <= MAX_OBJECTIVE_CHARS
    && isGoalStatus(g.status) && typeof g.tokensUsed === "number" && Number.isFinite(g.tokensUsed) && g.tokensUsed >= 0
    && typeof g.createdAtTurn === "string" && g.createdAtTurn.length > 0
    && typeof g.updatedAtTurn === "string" && g.updatedAtTurn.length > 0
    && (g.tokenBudget === undefined || (typeof g.tokenBudget === "number" && Number.isSafeInteger(g.tokenBudget) && g.tokenBudget > 0))
    && (g.note === undefined || typeof g.note === "string")
    && (g.usageUncertain === undefined || g.usageUncertain === true)
    && (g.blockedReason === undefined || typeof g.blockedReason === "string")
    && (g.blockedRounds === undefined || (typeof g.blockedRounds === "number" && Number.isSafeInteger(g.blockedRounds) && g.blockedRounds >= 0));
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUSES as readonly string[]).includes(value);
}

/** Create the run's goal. Exactly one may be unfinished at a time. */
export function createGoal(
  existing: GoalRecord | undefined,
  objective: string,
  createdAtTurn: string,
  tokenBudget?: number,
): GoalTransition {
  if (existing !== undefined && (existing.status === "active" || existing.status === "paused_by_user" || existing.status === "paused_by_system" || existing.status === "budget_exhausted")) {
    return { ok: false, code: "goal_exists", message: "an unfinished goal already exists; resolve it before creating another" };
  }

  if (objective.trim().length === 0) {
    return { ok: false, code: "empty_objective", message: "goal objective must be a non-empty string" };
  }

  if (objective.length > MAX_OBJECTIVE_CHARS) {
    return { ok: false, code: "empty_objective", message: `goal objective is ${objective.length} characters; the limit is ${MAX_OBJECTIVE_CHARS}` };
  }

  if (tokenBudget !== undefined && (Number.isInteger(tokenBudget) === false || tokenBudget <= 0)) {
    return { ok: false, code: "invalid_budget", message: "token_budget must be a positive integer when present" };
  }

  return {
    ok: true,
    goal: {
      objective,
      status: "active",
      tokensUsed: 0,
      createdAtTurn,
      updatedAtTurn: createdAtTurn,
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
    },
  };
}

/**
 * Mark the goal `complete` or `blocked`.
 *
 * `complete` needs the objective actually achieved — never the budget running
 * out, never merely stopping. `blocked` needs the same blocker recurring; a
 * single hard turn is difficulty, not an impasse. The repetition count is
 * carried by the caller (the loop counts consecutive blocked turns), because
 * this module owns the transition, not the transcript.
 */
export function updateGoalStatus(
  existing: GoalRecord | undefined,
  status: "complete" | "blocked",
  atTurn: string,
  options: { readonly consecutiveBlockedTurns?: number } = {},
): GoalTransition {
  if (existing === undefined) {
    return { ok: false, code: "no_goal", message: "no goal exists to update" };
  }

  if (existing.status === "complete" || existing.status === "cancelled") {
    return { ok: false, code: "terminal", message: `goal is already ${existing.status}; terminal goals do not move` };
  }

  if (isGoalStatus(status) === false) {
    return { ok: false, code: "terminal", message: "goal status must be complete or blocked" };
  }

  if (status === "blocked" && (options.consecutiveBlockedTurns ?? 0) < 3) {
    return {
      ok: false,
      code: "not_blocked_by_repetition",
      message: "blocked needs the same blocker for at least three consecutive goal turns; hard or slow work alone is not blocked",
    };
  }

  return {
    ok: true,
    goal: { ...existing, status, updatedAtTurn: atTurn },
  };
}

/** A person pauses, resumes, or cancels. The objective and constraints stay. */
export function applyUserGoalAction(
  existing: GoalRecord | undefined,
  action: "pause" | "resume" | "cancel",
  atTurn: string,
): GoalTransition {
  if (existing === undefined) {
    return { ok: false, code: "no_goal", message: "no goal exists for this user action" };
  }

  if (action === "pause") {
    if (existing.status !== "active") {
      return { ok: false, code: "terminal", message: `only an active goal may pause; it is ${existing.status}` };
    }
    return { ok: true, goal: { ...existing, status: "paused_by_user", updatedAtTurn: atTurn } };
  }

  if (action === "resume") {
    if (existing.status !== "paused_by_user" && existing.status !== "paused_by_system" && existing.status !== "budget_exhausted" && existing.status !== "blocked") {
      return { ok: false, code: "terminal", message: `only a paused, budget-exhausted or blocked goal may resume; it is ${existing.status}` };
    }
    return { ok: true, goal: { ...existing, status: "active", updatedAtTurn: atTurn } };
  }

  if (existing.status === "complete" || existing.status === "cancelled") {
    return { ok: false, code: "terminal", message: `goal is already ${existing.status}` };
  }

  return { ok: true, goal: { ...existing, status: "cancelled", updatedAtTurn: atTurn } };
}

/**
 * Account tokens against the goal's budget.
 *
 * Crossing the budget moves the goal to `budget_exhausted` — a terminal
 * *pause*, not a completion. Resuming after a refill keeps the original
 * objective and constraints; the interruption never rewrites what was asked.
 */
export function accountGoalTokens(
  existing: GoalRecord | undefined,
  tokens: number,
  atTurn: string,
): GoalTransition {
  if (existing === undefined) {
    return { ok: false, code: "no_goal", message: "no goal exists to account tokens against" };
  }

  if (existing.status === "complete" || existing.status === "cancelled") {
    return { ok: false, code: "terminal", message: `goal is already ${existing.status}; accounting stops at terminal states` };
  }

  if (Number.isFinite(tokens) === false || tokens < 0) {
    return { ok: false, code: "invalid_budget", message: "accounted tokens must be a non-negative number" };
  }

  const tokensUsed = existing.tokensUsed + tokens;
  const exhausted = existing.tokenBudget !== undefined && tokensUsed >= existing.tokenBudget;

  return {
    ok: true,
    goal: {
      ...existing,
      tokensUsed,
      status: exhausted ? "budget_exhausted" : existing.status,
      updatedAtTurn: atTurn,
    },
  };
}

/** Remaining budget, when the goal carries one. Absent means unbounded. */
export function remainingBudget(goal: GoalRecord): number | undefined {
  if (goal.tokenBudget === undefined) {
    return undefined;
  }
  return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}
