/**
 * Plan mode (WP21.2: C28/L25) plus the mechanical checklist (Codex `update_plan`).
 *
 * Two different ideas share one name in the wild, so this module keeps them
 * apart on purpose:
 *
 * - **Plan mode** is an execution constraint: while it is on, the run may
 *   explore and design but must not mutate the workspace. Entering is a
 *   decision; leaving needs the user's approval (`exit_plan_mode` is the only
 *   way out, and the adapter asks permission before running it). `/mode` is a
 *   *permission* mode (`read-only|confirm|auto-edit`) and can never stand in
 *   for this.
 * - **`update_plan`** is the model's own checklist inside a working run:
 *   pending/in_progress/completed steps with at most one `in_progress`. Codex
 *   forbids it *in* Plan mode; Trylo keeps that rule so the two cannot cover
 *   for each other.
 *
 * One discriminated union per idea, one owner each. No boolean stacks.
 */

export type PlanModeState =
  | { readonly kind: "working" }
  | { readonly kind: "plan"; readonly enteredAtTurn: string }
  | { readonly kind: "awaiting_approval"; readonly planText: string };

export type PlanModeTransition =
  | { readonly ok: true; readonly state: PlanModeState }
  | { readonly ok: false; readonly code: PlanModeReject; readonly message: string };

export type PlanModeReject =
  | "already_in_plan"
  | "not_in_plan"
  | "approval_pending"
  | "no_plan_to_approve"
  | "empty_plan";

export function initialPlanMode(): PlanModeState {
  return { kind: "working" };
}

/** Model asks to enter plan mode. Only a working run may enter. */
export function enterPlanMode(state: PlanModeState, turnId: string): PlanModeTransition {
  if (state.kind === "plan" || state.kind === "awaiting_approval") {
    return { ok: false, code: "already_in_plan", message: "already in plan mode; exit before entering again" };
  }

  if (turnId.trim().length === 0) {
    return { ok: false, code: "already_in_plan", message: "turn id is required to enter plan mode" };
  }

  return { ok: true, state: { kind: "plan", enteredAtTurn: turnId } };
}

/** Model presents its plan and waits for the user. Only a plan run may do so. */
export function submitPlanForApproval(state: PlanModeState, planText: string): PlanModeTransition {
  if (state.kind === "awaiting_approval") {
    return { ok: false, code: "approval_pending", message: "a plan is already awaiting approval" };
  }

  if (state.kind !== "plan") {
    return { ok: false, code: "not_in_plan", message: "not in plan mode; enter plan mode before submitting a plan" };
  }

  if (planText.trim().length === 0) {
    return { ok: false, code: "empty_plan", message: "plan text must not be empty" };
  }

  return { ok: true, state: { kind: "awaiting_approval", planText } };
}

/** The user's verdict on the pending plan. Approval is the only exit. */
export function resolvePlanApproval(
  state: PlanModeState,
  verdict: "approved" | "rejected",
): PlanModeTransition {
  if (state.kind !== "awaiting_approval") {
    return { ok: false, code: "no_plan_to_approve", message: "no plan is awaiting approval" };
  }

  if (verdict === "approved") {
    return { ok: true, state: { kind: "working" } };
  }

  return { ok: true, state: { kind: "plan", enteredAtTurn: "resumed-after-rejection" } };
}

export const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"] as const;

export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export type PlanStep = {
  readonly step: string;
  readonly status: PlanStepStatus;
};

export type PlanChecklist =
  | { readonly ok: true; readonly steps: ReadonlyArray<PlanStep> }
  | { readonly ok: false; readonly message: string };

const MAX_PLAN_STEPS = 50;
const MAX_STEP_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

/**
 * Validate one `update_plan` payload.
 *
 * Replace-the-list, like `todo_write`: the model hands over the whole
 * checklist as it now stands, so the list is always self-consistent. At most
 * one step may be `in_progress`; a checklist that claims two live steps is
 * refusing to say what it is actually doing.
 */
export function validatePlanChecklist(argumentsValue: Record<string, unknown>): PlanChecklist {
  const raw = argumentsValue["plan"];
  if (Array.isArray(raw) === false) {
    return { ok: false, message: "plan must be an array of {step, status}" };
  }

  if (raw.length > MAX_PLAN_STEPS) {
    return { ok: false, message: `plan holds ${raw.length} steps; the limit is ${MAX_PLAN_STEPS}` };
  }

  const steps: PlanStep[] = [];
  let live = 0;

  for (const entry of raw) {
    if (isRecord(entry) === false) {
      return { ok: false, message: "every plan step must be an object with step and status" };
    }

    const text = entry["step"];
    const status = entry["status"];

    if (typeof text !== "string" || text.trim().length === 0) {
      return { ok: false, message: "every plan step needs a non-empty step string" };
    }

    if (text.length > MAX_STEP_CHARS) {
      return { ok: false, message: `plan step is ${text.length} characters; the limit is ${MAX_STEP_CHARS}` };
    }

    if (typeof status !== "string" || (PLAN_STEP_STATUSES as readonly string[]).includes(status) === false) {
      return { ok: false, message: `plan step status must be one of: ${PLAN_STEP_STATUSES.join(", ")}` };
    }

    if (status === "in_progress") {
      live += 1;
    }

    steps.push({ step: text, status: status as PlanStepStatus });
  }

  if (live > 1) {
    return { ok: false, message: `plan has ${live} in_progress steps; at most one may be live` };
  }

  return { ok: true, steps };
}

/**
 * Whether `update_plan` may run in this mode.
 *
 * Codex forbids the checklist *inside* Plan mode (it is a TODO tool, not a
 * planning tool); Trylo keeps the rule so a run cannot look busy in plan
 * mode while never writing a plan.
 */
export function mayUpdatePlan(mode: PlanModeState): boolean {
  return mode.kind === "working";
}
