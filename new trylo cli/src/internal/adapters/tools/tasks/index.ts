import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import {
  claimTask,
  linkDependency,
  nextTaskId,
  renderTask,
  validateNewTask,
  type PersistentTask,
} from "../../../domain/persistent-tasks.js";

/**
 * Persistent task CRUD with dependencies and claims (WP21.2: L24).
 *
 * Four tools over one store, one id space:
 *
 * - `task_create {subject, description, activeForm?}` — numeric id, never
 *   reused (high-water mark only moves up, like old `utils/tasks.ts`).
 * - `task_get {taskId}` — read-only; unknown ids return null data, not an
 *   error throw, so the model can tell "missing" from "broken".
 * - `task_update {taskId, status?, owner?, description?, claim?, blockedBy?}`
 *   — status moves, claims admit one owner, dependencies link both
 *   directions. `completed` is a list fact, never a quality verdict.
 * - `task_list {}` — every row with its blockers, so the next turn can see
 *   what stands in the way without re-asking.
 *
 * The store is injected: production passes a directory-backed map, tests
 * pass memory. The transition table (`domain/persistent-tasks.ts`) never
 * touches either, which is what keeps claim races decidable in one place.
 */

const CREATE_BINDING: ToolBinding = {
  name: "task_create",
  description: "Create one persistent task. Returns its numeric id, which is never reused.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 4000 },
      activeForm: { type: "string", maxLength: 200 },
    },
    required: ["subject", "description"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const GET_BINDING: ToolBinding = {
  name: "task_get",
  description: "Read one persistent task by id. Unknown ids return null, not a throw.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const UPDATE_BINDING: ToolBinding = {
  name: "task_update",
  description:
    "Update status, owner, description, or dependencies of one task. Claiming respects blocks and single ownership; completed never means verified.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      status: { type: "string", enum: ["pending", "in_progress", "completed"] },
      owner: { type: "string" },
      description: { type: "string", maxLength: 4000 },
      claim: { type: "boolean", description: "Set true to claim this task for owner." },
      blocks: { type: "string", description: "One task id this task now blocks." },
      blockedBy: { type: "string", description: "One task id that now blocks this task." },
    },
    required: ["taskId"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const LIST_BINDING: ToolBinding = {
  name: "task_list",
  description: "List every persistent task with status, owner, and dependencies.",
  sideEffect: "read_only",
  parameters: { type: "object", properties: {} },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 16_384, maxLines: 400 },
};

export type PersistentTaskSeed = {
  readonly tasks?: ReadonlyArray<PersistentTask>;
  readonly highWaterMark?: number;
};

export function createPersistentTaskTools(seed: PersistentTaskSeed = {}): ToolPort {
  let tasks: PersistentTask[] = [...(seed.tasks ?? [])];
  let highWaterMark = seed.highWaterMark ?? seed.tasks?.reduce((high, task) => {
    const numeric = Number.parseInt(task.id, 10);
    return Number.isNaN(numeric) ? high : Math.max(high, numeric);
  }, 0) ?? 0;

  function find(id: string): PersistentTask | undefined {
    return tasks.find((task) => task.id === id);
  }

  function replace(updated: PersistentTask): void {
    tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
  }

  return {
    snapshot() {
      return [CREATE_BINDING, GET_BINDING, UPDATE_BINDING, LIST_BINDING];
    },
    async execute(call: ToolCallRequest, _signal: AbortSignal): Promise<ToolOutcome> {
      if (call.name === "task_create") {
        const validated = validateNewTask(call.arguments as Record<string, unknown>);
        if (validated.ok === false) {
          return { outcome: "error", code: "invalid_arguments", message: validated.message };
        }

        const next = nextTaskId({ tasks, highWaterMark });

        highWaterMark = next.highWaterMark;
        const task: PersistentTask = {
          id: next.id,
          subject: validated.input.subject,
          description: validated.input.description,
          status: "pending",
          blocks: [],
          blockedBy: [],
          ...(validated.input.activeForm === undefined ? {} : { activeForm: validated.input.activeForm }),
        };

        tasks = [...tasks, task];

        return {
          outcome: "result",
          value: { task: { id: task.id, subject: task.subject } },
          output: `Task #${task.id} created: ${task.subject}`,
          truncated: false,
        };
      }

      if (call.name === "task_get") {
        const taskId = call.arguments["taskId"];
        if (typeof taskId !== "string" || taskId.length === 0) {
          return { outcome: "error", code: "invalid_arguments", message: "taskId must be a non-empty string" };
        }

        const task = find(taskId);
        if (task === undefined) {
          return { outcome: "result", value: { task: null }, output: "Task not found", truncated: false };
        }

        return {
          outcome: "result",
          value: {
            task: {
              id: task.id,
              subject: task.subject,
              description: task.description,
              status: task.status,
              blocks: [...task.blocks],
              blockedBy: [...task.blockedBy],
              ...(task.owner === undefined ? {} : { owner: task.owner }),
            },
          },
          output: renderTask(task),
          truncated: false,
        };
      }

      if (call.name === "task_update") {
        const taskId = call.arguments["taskId"];
        if (typeof taskId !== "string" || taskId.length === 0) {
          return { outcome: "error", code: "invalid_arguments", message: "taskId must be a non-empty string" };
        }

        const existing = find(taskId);
        if (existing === undefined) {
          return { outcome: "error", code: "task_not_found", message: `task ${taskId} does not exist` };
        }

        let current: PersistentTask = existing;
        const status = call.arguments["status"];
        if (status !== undefined) {
          if (status !== "pending" && status !== "in_progress" && status !== "completed") {
            return { outcome: "error", code: "invalid_arguments", message: "status must be pending, in_progress, or completed" };
          }
          current = { ...current, status };
        }

        const description = call.arguments["description"];
        if (description !== undefined) {
          if (typeof description !== "string" || description.trim().length === 0) {
            return { outcome: "error", code: "invalid_arguments", message: "description must be a non-empty string" };
          }
          current = { ...current, description };
        }

        const owner = call.arguments["owner"];
        const claim = call.arguments["claim"];
        if (claim === true) {
          if (typeof owner !== "string" || owner.length === 0) {
            return { outcome: "error", code: "invalid_arguments", message: "claim needs an owner string" };
          }

          // Single focus is always on: the busy check runs atomically with
          // the claim, so an agent holding an open task cannot take a second
          // one without finishing or releasing the first. The verdict names
          // the task already held.
          const verdict = claimTask(tasks.map((task) => (task.id === current.id ? current : task)), taskId, owner, {
            checkAgentBusy: true,
          });
          if (verdict.ok === false) {
            return { outcome: "error", code: verdict.reason, message: verdict.message };
          }

          current = verdict.task;
        } else if (typeof owner === "string") {
          current = { ...current, owner };
        }

        const candidateTasks = tasks.map(task => task.id === current.id ? current : task);
        const blocks = call.arguments["blocks"];
        const blockedBy = call.arguments["blockedBy"];
        if (typeof blocks === "string" || typeof blockedBy === "string") {
          const fromId = typeof blocks === "string" ? taskId : (blockedBy as string);
          const toId = typeof blocks === "string" ? (blocks as string) : taskId;
          const linked = linkDependency(candidateTasks, fromId, toId);
          if (linked.ok === false) {
            return { outcome: "error", code: "invalid_dependency", message: linked.message };
          }

          tasks = [...linked.tasks];
          const refreshed = find(taskId);
          if (refreshed !== undefined) {
            current = refreshed;
          }
        } else {
          replace(current);
        }

        return {
          outcome: "result",
          value: { task: { id: current.id, status: current.status } },
          output: renderTask(current),
          truncated: false,
        };
      }

      if (call.name === "task_list") {
        const lines = tasks.length === 0 ? ["no persistent tasks"] : tasks.map(renderTask);
        return {
          outcome: "result",
          value: {
            tasks: tasks.map((task) => ({
              id: task.id,
              subject: task.subject,
              status: task.status,
              blocks: [...task.blocks],
              blockedBy: [...task.blockedBy],
              ...(task.owner === undefined ? {} : { owner: task.owner }),
            })),
          },
          output: lines.join("\n\n"),
          truncated: false,
        };
      }

      return { outcome: "unknown", code: "unknown_tool", message: `task port does not have ${call.name}` };
    },
    async cancel(): Promise<void> {
      // Synchronous store: nothing in flight to stop.
    },
  };
}
