import type { JsonObject, JsonValue } from "../../../protocol/envelope.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import {
  accountGoalTokens,
  applyUserGoalAction,
  createGoal,
  remainingBudget,
  updateGoalStatus,
  type GoalRecord,
} from "../../../domain/goal.js";

/**
 * Continuing goals with budget and recovery (WP21.3: C61).
 *
 * Five bindings over one record:
 *
 * - `create_goal {objective, token_budget?}` — one unfinished goal at a
 *   time, explicit objective, optional positive budget.
 * - `get_goal {}` — the current goal with status, usage, and remaining
 *   budget. No goal is a null answer, not a throw.
 * - `update_goal {status: complete|blocked}` — `complete` only when the
 *   objective is achieved; `blocked` only after the same blocker has been
 *   reported on three consecutive `update_goal` calls. The count lives in
 *   this adapter, not in the arguments: the model names the status, the
 *   mechanism counts. A single hard turn stays refused with
 *   `not_blocked_by_repetition (n/3)`.
 * - `goal_user_action` / `goal_account_tokens` — user pause/resume/cancel
 *   and budget accounting on the same record, so recovery after interruption
 *   finds the original objective and constraints still there.
 *
 * Two honest limits, stated here rather than hidden:
 *
 * - The adapter counts consecutive blocked *requests*, not consecutive goal
 *   *turns*: three `update_goal{blocked}` calls in a row satisfy it, even
 *   inside one turn. Every attempt is a journaled tool call WP27 can audit,
 *   which is strictly more evidence than a self-supplied number — but the
 *   true turn-consecutiveness counter belongs to the loop (deferred to
 *   WP23/WP26), and this record says so.
 * - The goal owns no learning machinery: no retrieval, no reflection, no
 *   asset writes.
 */

const CREATE_BINDING: ToolBinding = {
  name: "create_goal",
  description:
    "Create the run's continuing goal. One unfinished goal at a time; explicit objective, optional positive token_budget.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      objective: { type: "string", maxLength: 2000 },
      token_budget: { type: "integer", minimum: 1 },
    },
    required: ["objective"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const GET_BINDING: ToolBinding = {
  name: "get_goal",
  description: "Read the current goal: status, budgets, usage, and remaining tokens.",
  sideEffect: "read_only",
  parameters: { type: "object", properties: {} },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const UPDATE_BINDING: ToolBinding = {
  name: "update_goal",
  description:
    "Mark the goal complete (objective achieved) or report it blocked. Blocked needs three consecutive update_goal calls with status blocked; the count is kept here, not supplied by the caller. Budget exhaustion never completes.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["complete", "blocked"] },
    },
    required: ["status"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const USER_ACTION_BINDING: ToolBinding = {
  name: "goal_user_action",
  description: "Pause, resume, or cancel the goal as the user. Resume keeps the original objective and constraints.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["pause", "resume", "cancel"] },
    },
    required: ["action"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const ACCOUNT_BINDING: ToolBinding = {
  name: "goal_account_tokens",
  description: "Account tokens against the goal budget. Crossing the budget moves to budget_exhausted, never complete.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: { tokens: { type: "number", minimum: 0 } },
    required: ["tokens"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

export type GoalPortOptions = {
  readonly managed?: true;
  readonly turnId?: string;
  /** Validated session projection; the journal remains the only durable writer. */
  readonly seed?: GoalRecord;
};

function renderGoal(goal: GoalRecord): string {
  const remaining = remainingBudget(goal);
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Tokens used: ${goal.tokensUsed}${goal.tokenBudget === undefined ? "" : ` / ${goal.tokenBudget}`}${remaining === undefined ? "" : ` (remaining ${remaining})`}`,
  ];

  return lines.join("\n");
}

function goalValue(goal: GoalRecord): JsonObject {
  const remaining = remainingBudget(goal);
  const base: Record<string, JsonValue> = {
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
  };

  if (goal.tokenBudget !== undefined) {
    base["tokenBudget"] = goal.tokenBudget;
  }

  if (remaining !== undefined) {
    base["remaining"] = remaining;
  }

  return base;
}

export function createGoalTools(options: GoalPortOptions = {}): ToolPort & {
  current(): GoalRecord | undefined;
  replaceFromHost(value: GoalRecord): void;
} {
  let goal: GoalRecord | undefined = options.seed;
  const turnId = options.turnId ?? "turn-1";
  // Consecutive `update_goal{blocked}` reports observed by this adapter.
  // Reset by anything that moves the goal elsewhere (create, complete,
  // user action, token accounting); reads never reset it.
  let blockedReports = 0;

  function resetBlockedCounter(): void {
    blockedReports = 0;
  }

  return {
    current: () => goal,
    replaceFromHost: value => { goal = value; },
    snapshot() {
      return options.managed ? [GET_BINDING, UPDATE_BINDING] : [CREATE_BINDING, GET_BINDING, UPDATE_BINDING, USER_ACTION_BINDING, ACCOUNT_BINDING];
    },
    async execute(call: ToolCallRequest, _signal: AbortSignal): Promise<ToolOutcome> {
      if (options.managed && ["create_goal", "goal_user_action", "goal_account_tokens"].includes(call.name)) {
        return { outcome: "error", code: "host_owned_goal_control", message: "Goal creation, user actions and usage accounting belong to the host, not the model." };
      }

      if (call.name === "create_goal") {
        const objective = call.arguments["objective"];
        const budget = call.arguments["token_budget"];

        if (typeof objective !== "string") {
          return { outcome: "error", code: "invalid_arguments", message: "objective must be a string" };
        }

        if (budget !== undefined && (typeof budget !== "number" || Number.isInteger(budget) === false)) {
          return { outcome: "error", code: "invalid_arguments", message: "token_budget must be a positive integer when present" };
        }

        const transition = createGoal(
          goal,
          objective,
          turnId,
          budget === undefined ? undefined : (budget as number),
        );
        if (transition.ok === false) {
          return { outcome: "error", code: transition.code, message: transition.message };
        }

        goal = transition.goal;
        resetBlockedCounter();

        return { outcome: "result", value: goalValue(goal), output: renderGoal(goal), truncated: false };
      }

      if (call.name === "get_goal") {
        if (goal === undefined) {
          return { outcome: "result", value: { goal: null }, output: "no goal", truncated: false };
        }
        return { outcome: "result", value: { goal: goalValue(goal) }, output: renderGoal(goal), truncated: false };
      }

      if (call.name === "update_goal") {
        const status = call.arguments["status"];
        if (status !== "complete" && status !== "blocked") {
          return { outcome: "error", code: "invalid_arguments", message: "status must be complete or blocked" };
        }

        if (status === "complete") {
          resetBlockedCounter();
          const transition = updateGoalStatus(goal, status, turnId);
          if (transition.ok === false) {
            return { outcome: "error", code: transition.code, message: transition.message };
          }

          goal = transition.goal;

          return { outcome: "result", value: goalValue(goal), output: renderGoal(goal), truncated: false };
        }

        blockedReports += 1;
        const transition = updateGoalStatus(goal, status, turnId, { consecutiveBlockedTurns: blockedReports });
        if (transition.ok === false) {
          return {
            outcome: "error",
            code: transition.code,
            message: `${transition.message} (blocked report ${blockedReports}/3)`,
          };
        }

        goal = transition.goal;
        resetBlockedCounter();

        return { outcome: "result", value: goalValue(goal), output: renderGoal(goal), truncated: false };
      }

      if (call.name === "goal_user_action") {
        const action = call.arguments["action"];
        if (action !== "pause" && action !== "resume" && action !== "cancel") {
          return { outcome: "error", code: "invalid_arguments", message: "action must be pause, resume, or cancel" };
        }

        const transition = applyUserGoalAction(goal, action, turnId);
        if (transition.ok === false) {
          return { outcome: "error", code: transition.code, message: transition.message };
        }

        goal = transition.goal;
        resetBlockedCounter();

        return { outcome: "result", value: goalValue(goal), output: renderGoal(goal), truncated: false };
      }

      if (call.name === "goal_account_tokens") {
        const tokens = call.arguments["tokens"];
        if (typeof tokens !== "number") {
          return { outcome: "error", code: "invalid_arguments", message: "tokens must be a number" };
        }

        const transition = accountGoalTokens(goal, tokens, turnId);
        if (transition.ok === false) {
          return { outcome: "error", code: transition.code, message: transition.message };
        }

        goal = transition.goal;
        resetBlockedCounter();

        return { outcome: "result", value: goalValue(goal), output: renderGoal(goal), truncated: false };
      }

      return { outcome: "unknown", code: "unknown_tool", message: `goal port does not have ${call.name}` };
    },
    async cancel(): Promise<void> {
      // Synchronous record: nothing in flight to stop.
    },
  };
}
