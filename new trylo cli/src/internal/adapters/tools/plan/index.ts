import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import {
  enterPlanMode,
  initialPlanMode,
  mayUpdatePlan,
  submitPlanForApproval,
  validatePlanChecklist,
  type PlanModeState,
  type PlanStep,
} from "../../../domain/plan-mode.js";

/**
 * Plan mode plus the mechanical checklist (WP21.2: C28/L25, Codex `update_plan`).
 *
 * Three tools, one constraint, and the constraint is now mechanical:
 *
 * - `enter_plan_mode` moves a working run into plan mode. Read-only and
 *   approval-free: entering harms nothing, it only forbids mutation until
 *   the plan is approved.
 * - `exit_plan_mode {plan}` presents the plan and records `awaiting_approval`.
 *   Read-only and approval-free like every WP21 binding: plan approval is a
 *   *user-input* decision (WP23 surface prompts the person), never a
 *   permission grant, so it never flows through the permission port.
 * - `update_plan {plan}` replaces the working checklist whole. Refused in
 *   plan mode (Codex rule kept), at most one `in_progress`, whole-list
 *   replacement like `todo_write`.
 *
 * Approval has no tool path. There is deliberately no `resolve_*` binding in
 * `snapshot()` *and* none in `execute()`: advertise-layer removal alone would
 * still leave the name callable for anyone who guesses it, because the loop
 * dispatches on names, not on catalog membership. The user's verdict arrives
 * through a host API on the shared cell (WP23 surface owns the prompt), never
 * through a tool call, so the model cannot approve its own plan even by
 * naming the function. Until WP23 wires the surface, a run that submits a
 * plan parks in `awaiting_approval` fail-closed: no mutation, no silent exit.
 */

const ENTER_BINDING: ToolBinding = {
  name: "enter_plan_mode",
  description:
    "Enter plan mode: explore and design, do not mutate the workspace. Exit only via exit_plan_mode with user approval.",
  sideEffect: "read_only",
  parameters: { type: "object", properties: {} },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const EXIT_BINDING: ToolBinding = {
  name: "exit_plan_mode",
  description:
    "Present the plan text for user approval and wait. Approval arrives via the user-input surface (WP23), never via permission; this call only records awaiting_approval.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      plan: { type: "string", maxLength: 20000, description: "The complete plan the user approves." },
    },
    required: ["plan"],
  },
  needsApproval: false,
  timeoutMs: 30_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const UPDATE_BINDING: ToolBinding = {
  name: "update_plan",
  description:
    "Replace the working checklist whole: each step is {step, status pending|in_progress|completed}, at most one in_progress. Refused in plan mode.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            step: { type: "string", maxLength: 500 },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["step", "status"],
        },
      },
      explanation: { type: "string", maxLength: 2000 },
    },
    required: ["plan"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

export type PlanPortOptions = {
  readonly turnId?: string;
  /**
   * Shared mutable cell. Production wiring creates one cell per workspace
   * catalog and lends it here: the port moves it, and the workspace
   * dispatcher reads it to refuse workspace mutation while it is not
   * `working`. Tests omit it and get a private cell. The cell is the seam
   * the WP23 surface will use for the host-side approval call.
   */
  readonly cell?: PlanModeCell;
};

/**
 * One workspace catalog, one plan state.
 *
 * The cell is a plain object (not a second service) so that exactly one
 * mutable fact exists per catalog: the port writes it through the domain
 * transitions, the workspace gate reads it, and the future host approval
 * writes it again. No copies, no second source of truth.
 */
export type PlanModeCell = {
  current: PlanModeState;
};

export function createPlanModeCell(): PlanModeCell {
  return { current: initialPlanMode() };
}

export function createPlanTools(options: PlanPortOptions = {}): ToolPort {
  const cell = options.cell ?? createPlanModeCell();
  let checklist: ReadonlyArray<PlanStep> = [];
  const turnId = options.turnId ?? "turn-1";

  function renderChecklist(steps: ReadonlyArray<PlanStep>): string {
    if (steps.length === 0) {
      return "plan checklist cleared";
    }
    return steps
      .map((item) => {
        const box = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
        return `${box} ${item.step}`;
      })
      .join("\n");
  }

  return {
    snapshot() {
      return [ENTER_BINDING, EXIT_BINDING, UPDATE_BINDING];
    },
    async execute(call: ToolCallRequest, _signal: AbortSignal): Promise<ToolOutcome> {
      if (call.name === "enter_plan_mode") {
        const transition = enterPlanMode(cell.current, turnId);
        if (transition.ok === false) {
          return { outcome: "error", code: transition.code, message: transition.message };
        }

        cell.current = transition.state;

        return {
          outcome: "result",
          value: { mode: "plan" },
          output: "entered plan mode. Explore and design; do not write or edit files. Use exit_plan_mode to present the plan for approval.",
          truncated: false,
        };
      }

      if (call.name === "exit_plan_mode") {
        const plan = call.arguments["plan"];
        if (typeof plan !== "string") {
          return { outcome: "error", code: "invalid_arguments", message: "plan must be the complete plan text" };
        }

        const transition = submitPlanForApproval(cell.current, plan);
        if (transition.ok === false) {
          return { outcome: "error", code: transition.code, message: transition.message };
        }

        cell.current = transition.state;

        return {
          outcome: "result",
          value: { mode: "awaiting_approval" },
          output: "plan submitted for approval. Waiting on the user; do not mutate the workspace until approval arrives.",
          truncated: false,
        };
      }

      if (call.name === "update_plan") {
        if (mayUpdatePlan(cell.current) === false) {
          return { outcome: "error", code: "not_allowed_in_plan_mode", message: "update_plan is a working checklist and is not allowed in plan mode" };
        }

        const validated = validatePlanChecklist(call.arguments as Record<string, unknown>);
        if (validated.ok === false) {
          return { outcome: "error", code: "invalid_arguments", message: validated.message };
        }

        checklist = validated.steps;
        const counts = {
          total: checklist.length,
          completed: checklist.filter((item) => item.status === "completed").length,
          inProgress: checklist.filter((item) => item.status === "in_progress").length,
          pending: checklist.filter((item) => item.status === "pending").length,
        };

        return {
          outcome: "result",
          value: { steps: checklist.map((item) => ({ step: item.step, status: item.status })), counts },
          output: `Plan updated\n${renderChecklist(checklist)}`,
          truncated: false,
        };
      }

      return { outcome: "unknown", code: "unknown_tool", message: `plan port does not have ${call.name}` };
    },
    async cancel(): Promise<void> {
      // No async work to stop: mode moves and checklists replace synchronously.
    },
  };
}
