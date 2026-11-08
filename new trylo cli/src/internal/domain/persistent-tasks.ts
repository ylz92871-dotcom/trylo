/**
 * Persistent tasks (WP21.2: L24, companion to C27/L23 `todo_write`).
 *
 * `todo_write` is the model's scratch list for one run: in-memory, replaced
 * whole, gone when the run ends. Persistent tasks are the opposite: one row
 * per task, addressed by a stable id, with dependencies (`blocks`/`blockedBy`)
 * and an owner (`claim`) that survives across turns.
 *
 * Both lists are mounted at once, and both stay usable: they are alternative
 * display paths by convention, not by mechanism. Use the persistent list for
 * work with dependencies, ownership, or a life beyond the turn; use
 * `todo_write` for scratch. (Old CLI gates the two behind one flag,
 * `isTodoV2Enabled()`; a shared gate is deferred, so the convention is stated
 * here instead of enforced.)
 *
 * Mechanical reuse of old CLI `utils/tasks.ts`: numeric ids that never
 * repeat (high-water mark), `blocks`/`blockedBy` kept in both directions,
 * claim refused when already claimed, already complete, or blocked by an
 * unfinished task, plus an `agent_busy` guard for single-focus claims. The
 * file layout is the seam: production injects a directory, tests inject
 * memory, and the transition table below never touches either.
 */

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;

export type PersistentTaskStatus = (typeof TASK_STATUSES)[number];

export type PersistentTask = {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly status: PersistentTaskStatus;
  readonly blocks: ReadonlyArray<string>;
  readonly blockedBy: ReadonlyArray<string>;
};

export type TaskStoreSnapshot = {
  readonly tasks: ReadonlyArray<PersistentTask>;
  readonly highWaterMark: number;
};

export function emptyTaskSnapshot(): TaskStoreSnapshot {
  return { tasks: [], highWaterMark: 0 };
}

export type ClaimVerdict =
  | { readonly ok: true; readonly task: PersistentTask }
  | { readonly ok: false; readonly reason: "task_not_found" | "already_claimed" | "already_resolved" | "blocked" | "agent_busy"; readonly message: string };

function unfinishedIds(tasks: ReadonlyArray<PersistentTask>): Set<string> {
  return new Set(tasks.filter((task) => task.status !== "completed").map((task) => task.id));
}

function findTask(tasks: ReadonlyArray<PersistentTask>, id: string): PersistentTask | undefined {
  return tasks.find((task) => task.id === id);
}

/** Next numeric id. Ids never repeat: the high-water mark only moves up. */
export function nextTaskId(snapshot: TaskStoreSnapshot): { readonly id: string; readonly highWaterMark: number } {
  const next = snapshot.highWaterMark + 1;
  return { id: String(next), highWaterMark: next };
}

export type NewTaskInput = {
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string;
};

export type NewTaskValidation =
  | { readonly ok: true; readonly input: NewTaskInput }
  | { readonly ok: false; readonly message: string };

const MAX_SUBJECT_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4000;

/** Validate one `task_create` payload before anything is stored. */
export function validateNewTask(raw: Record<string, unknown>): NewTaskValidation {
  const subject = raw["subject"];
  const description = raw["description"];
  const activeForm = raw["activeForm"];

  if (typeof subject !== "string" || subject.trim().length === 0) {
    return { ok: false, message: "task subject must be a non-empty string" };
  }

  if (subject.length > MAX_SUBJECT_CHARS) {
    return { ok: false, message: `task subject is ${subject.length} characters; the limit is ${MAX_SUBJECT_CHARS}` };
  }

  if (typeof description !== "string" || description.trim().length === 0) {
    return { ok: false, message: "task description must be a non-empty string" };
  }

  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, message: `task description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}` };
  }

  if (activeForm !== undefined && (typeof activeForm !== "string" || activeForm.length > MAX_SUBJECT_CHARS)) {
    return { ok: false, message: `activeForm must be a string of at most ${MAX_SUBJECT_CHARS} characters` };
  }

  return {
    ok: true,
    input: {
      subject,
      description,
      ...(activeForm === undefined ? {} : { activeForm }),
    },
  };
}

/**
 * Attempt to claim one task for one agent.
 *
 * The verdict names the exact reason a claim did not happen, because "no"
 * without a reason becomes a retry loop: `already_claimed` means ask the
 * owner, `blocked` names the blockers, `agent_busy` names the task the agent
 * already holds, and `already_resolved` means the work is done — claiming it
 * again would rewrite history, not continue it.
 */
export function claimTask(
  tasks: ReadonlyArray<PersistentTask>,
  taskId: string,
  claimant: string,
  options: { readonly checkAgentBusy?: boolean } = {},
): ClaimVerdict {
  const task = findTask(tasks, taskId);
  if (task === undefined) {
    return { ok: false, reason: "task_not_found", message: `task ${taskId} does not exist` };
  }

  if (task.owner !== undefined && task.owner !== claimant) {
    return { ok: false, reason: "already_claimed", message: `task ${taskId} is already claimed by ${task.owner}` };
  }

  if (task.status === "completed") {
    return { ok: false, reason: "already_resolved", message: `task ${taskId} is already completed` };
  }

  const unfinished = unfinishedIds(tasks);
  const blockers = task.blockedBy.filter((id) => unfinished.has(id));
  if (blockers.length > 0) {
    return { ok: false, reason: "blocked", message: `task ${taskId} is blocked by ${blockers.map((id) => `#${id}`).join(", ")}` };
  }

  if (options.checkAgentBusy === true) {
    const busyWith = tasks.filter(
      (entry) => entry.id !== taskId && entry.owner === claimant && entry.status !== "completed",
    );
    if (busyWith.length > 0) {
      return {
        ok: false,
        reason: "agent_busy",
        message: `${claimant} already holds ${busyWith.map((entry) => `#${entry.id}`).join(", ")}`,
      };
    }
  }

  return { ok: true, task: { ...task, owner: claimant } };
}

/**
 * Keep `blocks`/`blockedBy` consistent in both directions.
 *
 * A dependency is two facts, not one: A saying it blocks B while B says
 * nothing is a half-link the next reader will misread. Both rows move
 * together or the link is refused.
 */
export function linkDependency(
  tasks: ReadonlyArray<PersistentTask>,
  fromId: string,
  toId: string,
): { readonly ok: true; readonly tasks: ReadonlyArray<PersistentTask> } | { readonly ok: false; readonly message: string } {
  if (fromId === toId) {
    return { ok: false, message: "a task cannot block itself" };
  }

  const from = findTask(tasks, fromId);
  const to = findTask(tasks, toId);
  if (from === undefined || to === undefined) {
    return { ok: false, message: `dependency needs two existing tasks; missing ${from === undefined ? fromId : toId}` };
  }

  return {
    ok: true,
    tasks: tasks.map((entry) => {
      if (entry.id === fromId && entry.blocks.includes(toId) === false) {
        return { ...entry, blocks: [...entry.blocks, toId] };
      }

      if (entry.id === toId && entry.blockedBy.includes(fromId) === false) {
        return { ...entry, blockedBy: [...entry.blockedBy, fromId] };
      }

      return entry;
    }),
  };
}

/**
 * Render one task the way `TaskGet` readers need it: identity, state, who
 * holds it, and what stands in its way. A `completed` row is a fact about
 * the list, never a verdict about quality — verification stays elsewhere.
 */
export function renderTask(task: PersistentTask): string {
  const lines = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`, `Description: ${task.description}`];

  if (task.owner !== undefined) {
    lines.push(`Owner: ${task.owner}`);
  }

  if (task.blockedBy.length > 0) {
    lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  }

  if (task.blocks.length > 0) {
    lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
  }

  return lines.join("\n");
}
