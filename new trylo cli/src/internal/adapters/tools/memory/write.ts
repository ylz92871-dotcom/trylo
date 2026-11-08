import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import type { UserMemoryService } from "../../../integration/user-learning/index.js";
import {
  memoryReceiptText,
  type MemoryCommandResult,
} from "../../../learning/domains/user/memory-command.js";
import { MEMORY_FACT_KINDS, type MemoryFactKind } from "../../../learning/domains/user/memory-fact.js";

/**
 * `memory_remember` / `memory_forget`：用户在对话里明确要求"记住/改正/忘掉"
 * 时的正式写入口。
 *
 * 为什么必须是一个工具，而不是一段提示词：模型需要**拿到一个结构化结果**才能
 * 说"记好了"。没有结果就没有回执，没有回执的任何"已保存"都只是话术——这正是
 * 用户遇到的那次：项目根目录多了一个 `MEMORY.md`，正式账本里什么都没有。
 *
 * 两个工具只存在于 `--learning` 允许用户学习的运行里（见 `tools/index.ts`）。
 * 关闭时目录里没有它们，模型就没有任何可以声称成功的依据。
 *
 * 模型能提交的只有**命题与作用域种类**：session/turn/事件身份由宿主注入，
 * 记录 id 与版本由账本给出。模型改不了来源，也就不可能用一段网页或工具输出
 * 冒充用户明令。
 */

export const MEMORY_REMEMBER_TOOL = "memory_remember";
export const MEMORY_FORGET_TOOL = "memory_forget";
export const MEMORY_CORRECT_TOOL = "memory_correct";

export const MEMORY_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  MEMORY_REMEMBER_TOOL,
  MEMORY_FORGET_TOOL,
  MEMORY_CORRECT_TOOL,
]);

const FACT_KIND_LIST = MEMORY_FACT_KINDS.join(", ");

export const MEMORY_REMEMBER_BINDING: ToolBinding = {
  name: MEMORY_REMEMBER_TOOL,
  description:
    "Save something the user explicitly asked you to remember, into Trylo's own user memory. "
    + "Use it only when the user asks you to remember/keep a fact about themselves or this project, "
    + "and quote their wording: `statement` must appear in what the user just said. "
    + "This is NOT a file: never write a MEMORY.md or any project note to stand in for it. "
    + "If the user separately asks you to produce a MEMORY.md file, that is an ordinary file task — "
    + "do it, and report it as a project file, never as something remembered. "
    + `fact_kind is one of ${FACT_KIND_LIST}: identity_fact for who the user is, preference for how they `
    + "want to work with you, project_fact for a durable fact about this workspace. "
    + "Saving a fact never grants a permission, never changes how you address the user, and never makes "
    + "the user the author of the underlying model: a record saying they develop Trylo means they build "
    + "this product, not that they trained or own the model answering them. Answer about the product "
    + "and say you do not know about the base model's authorship rather than extending the fact. "
    + "Returns a structured result; only say \"saved\" when it says saved.",
  sideEffect: "workspace_write",
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Who or what the fact is about, e.g. the user's name." },
      statement: { type: "string", description: "The fact, using the user's own wording." },
      fact_kind: { type: "string", enum: [...MEMORY_FACT_KINDS] },
      scope: {
        type: "string",
        enum: ["user", "project"],
        description: "`user` for a fact about the person across projects; `project` for this workspace only.",
      },
    },
    required: ["subject", "statement", "fact_kind"],
    additionalProperties: false,
  },
  // Explicit persistence consent does not override the operator's tool policy.
  needsApproval: true,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

export const MEMORY_FORGET_BINDING: ToolBinding = {
  name: MEMORY_FORGET_TOOL,
  description:
    "Retract one saved user-memory fact by the record id `memory_search` reported. "
    + "Use the exact record_id in the record metadata, never document_id or a line_number suffix. "
    + "The fact stops being retrievable immediately; the ledger keeps the history. "
    + "Requires the current version so a stale call cannot overwrite a newer edit.",
  sideEffect: "workspace_write",
  parameters: {
    type: "object",
    properties: {
      record_id: { type: "string", description: "The record id a memory hit reported, e.g. `fact-…`." },
      expected_version: { type: "number", description: "The version the caller saw." },
    },
    required: ["record_id", "expected_version"],
    additionalProperties: false,
  },
  needsApproval: true,
  timeoutMs: 5_000,
  outputLimits: { maxBytes: 8_192, maxLines: 200 },
};

export const MEMORY_CORRECT_BINDING: ToolBinding = {
  ...MEMORY_FORGET_BINDING,
  name: MEMORY_CORRECT_TOOL,
  description: "Correct one saved user-memory fact using record_id and expected_version from its metadata, never document_id or line_number. Quote the user's new statement verbatim. This updates the same record instead of creating a contradictory second fact.",
  parameters: { ...MEMORY_FORGET_BINDING.parameters,
    properties: { record_id: { type: "string" }, expected_version: { type: "integer", minimum: 1 }, statement: { type: "string", minLength: 1 } },
    required: ["record_id", "expected_version", "statement"],
  },
};

export function createMemoryWriteTools(service: UserMemoryService): ToolPort {
  return {
    snapshot: () => [MEMORY_REMEMBER_BINDING, MEMORY_FORGET_BINDING, MEMORY_CORRECT_BINDING],

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (signal.aborted) return { outcome: "cancelled" };
      if (call.name === MEMORY_REMEMBER_TOOL) return runRemember(service, call);
      if (call.name === MEMORY_FORGET_TOOL || call.name === MEMORY_CORRECT_TOOL) return runForget(service, call);
      return { outcome: "unknown", code: "unknown_tool", message: `memory write tools do not implement ${call.name}` };
    },

    async cancel(): Promise<void> {
      // The writes are synchronous and bounded; there is nothing to unwind.
    },
  };
}

/**
 * A tool call's own identity, so a retried call reports instead of duplicating.
 * The service prefixes the turn, so two turns reusing the same call id cannot
 * collide either.
 */
function commandIdOf(call: ToolCallRequest): string {
  return call.toolCallId;
}

function textArgument(call: ToolCallRequest, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function factKindArgument(call: ToolCallRequest): MemoryFactKind | undefined {
  const value = call.arguments["fact_kind"];
  return typeof value === "string" && (MEMORY_FACT_KINDS as readonly string[]).includes(value)
    ? value as MemoryFactKind
    : undefined;
}

function outcomeOf(result: MemoryCommandResult, retracted = false): ToolOutcome {
  const receipt = retracted && (result.result === "saved" || result.result === "already_saved")
    ? `已撤回这条 Trylo 用户记忆（${result.recordId} v${result.version}），后续不再检索。` : memoryReceiptText(result);

  if (result.result === "saved" || result.result === "already_saved") {
    return { outcome: "result", value: { ...result, receipt }, output: receipt, truncated: false };
  }

  // Everything that is not a save is an error for the model: a failed or
  // disabled write must not look like a successful tool call, or the next
  // sentence is "记好了".
  const code = result.result === "disabled" ? "memory_disabled"
    : result.result === "pending" ? "memory_pending"
      : result.result === "rejected" ? `memory_rejected:${result.reason}`
        : "memory_write_failed";

  return { outcome: "error", code, message: receipt };
}

function runRemember(service: UserMemoryService, call: ToolCallRequest): ToolOutcome {
  const subject = textArgument(call, "subject"), statement = textArgument(call, "statement");
  const factKind = factKindArgument(call);
  const scopeKind = call.arguments["scope"] === "project" ? "project" : "user";

  if (subject === undefined || statement === undefined || factKind === undefined) {
    return {
      outcome: "error", code: "invalid_arguments",
      message: "memory_remember needs subject, statement and a valid fact_kind",
    };
  }

  return outcomeOf(service.remember({ commandId: commandIdOf(call), subject, statement, factKind, scopeKind }));
}

function runForget(service: UserMemoryService, call: ToolCallRequest): ToolOutcome {
  const recordId = textArgument(call, "record_id");
  const expectedVersion = call.arguments["expected_version"];
  if (recordId === undefined || typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
    return {
      outcome: "error", code: "invalid_arguments",
      message: "memory_forget needs record_id and an integer expected_version",
    };
  }

  if (call.name === MEMORY_CORRECT_TOOL) {
    const statement = textArgument(call, "statement");
    if (statement === undefined) return { outcome: "error", code: "invalid_arguments", message: "memory_correct needs a non-empty statement" };
    return outcomeOf(service.correct({ commandId: commandIdOf(call), recordId, expectedVersion, statement }));
  }

  return outcomeOf(service.retract({ commandId: commandIdOf(call), recordId, expectedVersion }), true);
}
