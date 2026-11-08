import { accountGoalTokens, applyUserGoalAction, createGoal, editGoal, updateGoalStatus, type GoalRecord } from "../../domain/goal.js";
import type { GoalExecutionPort } from "../../ports/goal.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { ToolOutcome } from "../../ports/tools.js";
import { createGoalTools } from "../../adapters/tools/goal/index.js";
import { restoredGoal } from "../../adapters/tools/workflow-history.js";

export type GoalCommand = { readonly version: 1; readonly action: "create" | "edit"; readonly objective: string; readonly tokenBudget?: number }
  | { readonly version: 1; readonly action: "resume" | "cancel"; readonly tokenBudget?: number };

export function parseGoalCommand(value: unknown): GoalCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_goal_command");

  const g = value as Record<string, unknown>;
  if (g.version !== 1 || !["create", "edit", "resume", "cancel"].includes(String(g.action))
    || ((g.action === "create" || g.action === "edit") && (typeof g.objective !== "string" || !g.objective.trim() || g.objective.length > 2000))
    || (g.tokenBudget !== undefined && (typeof g.tokenBudget !== "number" || !Number.isSafeInteger(g.tokenBudget) || g.tokenBudget <= 0))) {
    throw new Error("invalid_goal_command");
  }

  return value as GoalCommand;
}

type GoalSessionInput = {
  readonly command: GoalCommand; readonly records: readonly SessionRecord[];
  readonly session: Pick<SessionPort, "append">; readonly sessionId: string; readonly turnId: string;
  readonly now: () => number; readonly emit: (frame: object) => void;
};

async function persistGoalSnapshot(input: GoalSessionInput, goal: GoalRecord, usageWatermarks: Record<string, number>): Promise<void> {
  const result = await input.session.append({ type: "goal_state", sessionId: input.sessionId, turnId: input.turnId,
    at: new Date(input.now()).toISOString(), payload: { version: 1, goal: { ...goal }, usageWatermarks } });
  if (!result.ok) throw new Error(`goal_checkpoint_failed:${result.code}`);
  input.emit({ type: "goal_state", version: 1, goal });
}

/** One record owner, shared by model tools and the ordinary execution gap. */
export async function openGoalSession(input: GoalSessionInput): Promise<GoalExecutionPort & {
  readonly turnId: string;
  finish(result: { readonly status: string; readonly finishReason: string }, userAction?: "pause" | "cancel"): Promise<void>;
}> {
  const prior = restoredGoal(input.records);
  if (prior !== undefined && "outcome" in prior) throw new Error("invalid_goal_history");

  const command = input.command;
  const replacingCancelled = command.action === "create" && prior?.status === "cancelled";
  if (prior?.usageUncertain && command.action !== "cancel" && !replacingCancelled) {
    // Refresh stale Desktop history before refusing another run. Persist the
    // conservative recovery fact; never turn an unknown bill into zero usage.
    await persistGoalSnapshot(input, prior, {});
    throw new Error("goal_usage_reconciliation_required");
  }

  let transition;

  if (command.action === "create") transition = createGoal(prior, command.objective.trim(), input.turnId, command.tokenBudget);
  else if (command.action === "edit") transition = editGoal(prior, command.objective, input.turnId, command.tokenBudget);
  else {
    if (prior === undefined) throw new Error("no_goal");

    if (command.action === "resume" && command.tokenBudget !== undefined && (command.tokenBudget <= prior.tokensUsed
      || (prior.tokenBudget !== undefined && command.tokenBudget < prior.tokenBudget))) throw new Error("invalid_budget");

    if (command.action === "resume" && prior.tokenBudget !== undefined && prior.tokensUsed >= prior.tokenBudget
      && (command.tokenBudget === undefined || command.tokenBudget <= prior.tokensUsed)) throw new Error("goal_budget_refill_required");

    const budget = command.tokenBudget === undefined ? prior : { ...prior, tokenBudget: command.tokenBudget };

    // A crashed active record needs an explicit resume, never silent restart.
    transition = command.action === "resume" && budget.status === "active" ? { ok: true as const, goal: budget }
      : applyUserGoalAction(budget, command.action, input.turnId);
  }

  if (!transition.ok) throw new Error(transition.code);

  const initial = { ...transition.goal, blockedRounds: 0, blockedReason: "", updatedAtTurn: input.turnId };
  const owner = createGoalTools({ managed: true, seed: initial, turnId: input.turnId });
  const accounted = new Map<string, number>();
  let pendingBlock: string | undefined;
  let saved = "";
  const current = (): GoalRecord => owner.current() ?? initial;
  const save = async (): Promise<void> => {
    const goal = current();
    const usageWatermarks = Object.fromEntries(accounted);
    const signature = JSON.stringify({ goal, usageWatermarks });
    if (signature === saved) return;
    await persistGoalSnapshot(input, goal, usageWatermarks);
    saved = signature;
  };
  const account = (total: number, attemptId: string): void => {
    const previous = accounted.get(attemptId) ?? 0;
    if (!Number.isFinite(total) || total < previous) throw new Error("invalid_goal_usage");

    if (total === previous) {
      accounted.set(attemptId, total);
      return;
    }

    const goal = current();
    // Usage was incurred before the model's completion tool in this same
    // iteration. Settle it even at that terminal boundary; exhaustion wins.
    const charged = accountGoalTokens({ ...goal, status: "active" }, total - previous, input.turnId);
    if (!charged.ok) throw new Error(charged.code);

    accounted.set(attemptId, total);
    owner.replaceFromHost({ ...charged.goal, status: charged.goal.status === "budget_exhausted" ? "budget_exhausted" : goal.status });
  };

  await save();

  return {
    turnId: input.turnId, current,
    tools: {
      snapshot: () => owner.snapshot().map(binding => binding.name === "update_goal" ? { ...binding,
        description: "Report complete only when the objective is achieved. Report blocked with a stable reason; the host requires the same reason at three execution boundaries.",
        parameters: { ...binding.parameters, properties: { status: { type: "string", enum: ["complete", "blocked"] }, reason: { type: "string", maxLength: 1000 } } } } : binding),

      async execute(call, signal): Promise<ToolOutcome> {
        if (call.name === "update_goal" && call.arguments.status === "blocked") {
          const reason = call.arguments.reason;
          if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) return { outcome: "error", code: "invalid_arguments", message: "blocked requires a stable non-empty reason" };
          pendingBlock = reason.trim();
          return { outcome: "result", value: { ...current(), reportRegistered: true }, output: "Blocked report registered for this execution boundary. Continue useful work; repeated calls in this boundary count once.", truncated: false };
        }
        return owner.execute(call, signal);
      }, cancel: id => owner.cancel(id),
    },

    async checkpoint(totalTokens, attemptId = input.turnId, round) {
      account(totalTokens, attemptId);

      if (pendingBlock !== undefined && current().status === "active") {
        const goal = current();
        const rounds = goal.blockedReason === pendingBlock ? (goal.blockedRounds ?? 0) + 1 : 1;
        const blocked = updateGoalStatus(goal, "blocked", input.turnId, { consecutiveBlockedTurns: rounds });
        owner.replaceFromHost({ ...(blocked.ok ? blocked.goal : goal), blockedReason: pendingBlock, blockedRounds: rounds });
      } else if (round !== undefined && current().status === "active" && (current().blockedRounds ?? 0) > 0) owner.replaceFromHost({ ...current(), blockedRounds: 0, blockedReason: "" });

      pendingBlock = undefined;
      await save();
    },

    reminder: () => `Continuing goal: ${current().objective}\nPursue this explicit goal until complete. A normal answer does not complete it. Use get_goal and update_goal. Preserve all constraints and permissions. Ask the user when genuinely required. Never invent user approval or usage.`,

    async finish(result, userAction) {
      if (userAction !== undefined && (userAction === "cancel" || current().status !== "budget_exhausted")) {
        const action = applyUserGoalAction(current(), userAction, input.turnId);
        if (action.ok) owner.replaceFromHost(action.goal);
      }

      if (current().status === "active") owner.replaceFromHost({ ...current(), status: "paused_by_system",
        note: result.finishReason || `run_${result.status}`, updatedAtTurn: input.turnId });

      await save();
    },
  };
}
