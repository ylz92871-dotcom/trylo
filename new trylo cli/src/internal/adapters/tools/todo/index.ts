import type { JsonObject } from "../../../protocol/envelope.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";

/**
 * The model's own task list: whole-list replacement and a read-only query.
 *
 * Replace-the-list semantics, copied from the behaviour of the old CLI's
 * TodoWrite rather than from its code: every call hands over the *complete*
 * list as it now stands, so the list is always self-consistent and there is no
 * "update an entry that no longer exists" state to get into. The list lives in
 * this port's closure — the workspace is not touched, which is exactly why the
 * binding declares `read_only` and asks no approval. Across turns the model
 * restores the list through the workflow journal owner. `todo_read` exposes
 * that same state even after its original echo has left the prompt window.
 *
 * Validation runs before any mutation: a refused call leaves the previous list
 * whole, because half a new list over half an old one is the worst kind of
 * stale plan.
 */

const MAX_TODOS = 50;
const MAX_ITEM_CHARS = 500;
const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export const TODO_TOOL_NAMES: ReadonlySet<string> = new Set(["todo_write", "todo_read"]);

type TodoStatus = (typeof TODO_STATUSES)[number];

type TodoItem = {
  readonly content: string;
  readonly status: TodoStatus;
  readonly activeForm?: string;
};

const BINDING: ToolBinding = {
  name: "todo_write",
  description:
    "Replace the run's task list with the complete list as it now stands. Each item: content, status (pending | in_progress | completed), optional activeForm (present-continuous text shown while in progress). This is the whole list, not an edit: omit nothing you still intend to do.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: MAX_TODOS,
        items: {
          type: "object",
          properties: {
            content: { type: "string", maxLength: MAX_ITEM_CHARS },
            status: { type: "string", enum: [...TODO_STATUSES] },
            activeForm: {
              type: "string",
              maxLength: MAX_ITEM_CHARS,
              description: "Optional present-continuous wording for the in_progress row.",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

const READ_BINDING: ToolBinding = {
  name: "todo_read",
  description: "Read the current todo list and status counts without changing it. Use this to recover existing progress after continuation or context compaction; an empty list is reported as empty.",
  sideEffect: "read_only",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  needsApproval: false,
  timeoutMs: 5_000,
  // JSON can escape each valid code unit as six bytes; retain the whole
  // existing schema's maximum list rather than truncating recovered progress.
  outputLimits: { maxBytes: MAX_TODOS * (2 * MAX_ITEM_CHARS * 6 + 128) + 256, maxLines: 1 },
};

export function createTodoTools(): ToolPort {
  let todos: ReadonlyArray<TodoItem> = [];
  return {
    snapshot() {
      return [BINDING, READ_BINDING];
    },
    async execute(call: ToolCallRequest, _signal: AbortSignal): Promise<ToolOutcome> {
      if (call.name === "todo_read") {
        if (Object.keys(call.arguments).length > 0) {
          return { outcome: "error", code: "invalid_arguments", message: "todo_read takes no arguments and never changes the list" };
        }
        const value = { todos: todos.map(toJson), counts: countByStatus(todos) };
        return { outcome: "result", value,
          output: todos.length === 0 ? "todo list is empty" : JSON.stringify(value), truncated: false };
      }

      if (call.name !== "todo_write") {
        return {
          outcome: "unknown",
          code: "unknown_tool",
          message: `todo port does not have ${call.name}`,
        };
      }

      const parsed = parseTodos(call.arguments);
      if (!parsed.ok) {
        return { outcome: "error", code: "invalid_arguments", message: parsed.message };
      }

      const previousTotal = todos.length;

      todos = parsed.todos;

      return {
        outcome: "result",
        value: {
          todos: todos.map(toJson),
          counts: countByStatus(todos),
          previousTotal,
        },
        output: render(todos),
        truncated: false,
      };
    },
    async cancel(): Promise<void> {
      // No async work to stop: a todo write is finished the moment it is read.
    },
  };
}

type ParsedTodos = { readonly ok: true; readonly todos: ReadonlyArray<TodoItem> } | { readonly ok: false; readonly message: string };

function parseTodos(argumentsValue: JsonObject): ParsedTodos {
  const raw = argumentsValue["todos"];
  if (!Array.isArray(raw)) {
    return { ok: false, message: "todos must be an array of {content, status, activeForm?}" };
  }

  if (raw.length > MAX_TODOS) {
    return { ok: false, message: `todos holds ${raw.length} items; the limit is ${MAX_TODOS}` };
  }

  const items: TodoItem[] = [];

  for (const entry of raw) {
    const item = parseItem(entry);
    if (!item.ok) {
      return item;
    }
    items.push(item.todo);
  }

  return { ok: true, todos: items };
}

function parseItem(entry: unknown): { readonly ok: true; readonly todo: TodoItem } | { readonly ok: false; readonly message: string } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { ok: false, message: "every todo must be an object with content and status" };
  }

  const record = entry as Record<string, unknown>;
  const content = record["content"];
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: false, message: "every todo needs a non-empty content string" };
  }

  if (content.length > MAX_ITEM_CHARS) {
    return { ok: false, message: `content is ${content.length} characters; the limit is ${MAX_ITEM_CHARS}` };
  }

  const status = record["status"];
  if (typeof status !== "string" || !(TODO_STATUSES as readonly string[]).includes(status)) {
    return {
      ok: false,
      message: `status must be one of: ${TODO_STATUSES.join(", ")}`,
    };
  }

  const activeForm = record["activeForm"];
  if (activeForm !== undefined && (typeof activeForm !== "string" || activeForm.length > MAX_ITEM_CHARS)) {
    return { ok: false, message: `activeForm must be a string of at most ${MAX_ITEM_CHARS} characters` };
  }

  return {
    ok: true,
    todo: {
      content,
      status: status as TodoStatus,
      ...(activeForm === undefined ? {} : { activeForm: activeForm as string }),
    },
  };
}

function toJson(item: TodoItem): JsonObject {
  return {
    content: item.content,
    status: item.status,
    ...(item.activeForm === undefined ? {} : { activeForm: item.activeForm }),
  };
}

function countByStatus(items: ReadonlyArray<TodoItem>): JsonObject {
  return {
    total: items.length,
    completed: items.filter((item) => item.status === "completed").length,
    inProgress: items.filter((item) => item.status === "in_progress").length,
    pending: items.filter((item) => item.status === "pending").length,
  };
}

/**
 * Checkbox echo. The in-progress row shows `activeForm` when it has one — the
 * wording the model chose for "what is happening right now" — because that is
 * the sentence a reader of the transcript is looking for mid-task.
 */
function render(items: ReadonlyArray<TodoItem>): string {
  if (items.length === 0) {
    return "todo list cleared";
  }
  return items
    .map((item) => {
      const box = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
      const text = item.status === "in_progress" && item.activeForm !== undefined ? item.activeForm : item.content;
      return `${box} ${text}`;
    })
    .join("\n");
}
