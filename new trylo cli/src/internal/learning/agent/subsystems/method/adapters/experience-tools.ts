import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { ToolBinding, ToolOutcome, ToolPort } from "../../../../../ports/tools.js";
import { METHOD_CONTEXT_TOOL, type ExperienceRuntimePort, type ExperienceSelection, type ExperienceConditionRequest,
  type ExperienceSourceTrial } from "../experience-port.js";
import { isContext } from "../domain/experience-facts.js";
import { MAX_OBSERVATION_FEATURES, MAX_OBSERVATION_ID_CHARS, MAX_FEATURE_KEY_CHARS, MAX_FEATURE_VALUE_CHARS } from "../domain/inference-observations.js";
import { isMethodApplicationReport, MAX_APPLICATION_REPORT_CHARS } from "../domain/application-report.js";
import { boundedContextResult } from "./context-result-budget.js";

export { METHOD_CONTEXT_TOOL };

const SOURCE_TRIAL_RULE = "为检验真实待辨问题，可在context用trial:{versionId,scopeId}请求已注册且任务事实匹配范围的原方法试用；仅限当前机会，随后照常adopt和反馈。不要为刷门槛重复简单任务；不改变默认或权限。";

const BINDING: ToolBinding = {
  name: METHOD_CONTEXT_TOOL,
  description: "Before exploring a task, subtask or changed conditions, query reusable methods with a situation and semantic facts. Continue a bound opportunity without re-querying after ordinary tool results. After the selected method appears in the next planning slot, call adopt with its versionId, scopeId and actual reason before business execution; call deviate if inapplicable. Report blocking facts and resume normal analysis. Expand only to explain or repair an exception. correct revises a self-report's outcome or actual practice/result without adding a trial; do not make cosmetic edits to buy another review. These records never authorize business tools. " + SOURCE_TRIAL_RULE,
  sideEffect: "read_only", parallelSafe: false, needsApproval: false, timeoutMs: 10000,
  outputLimits: { maxBytes: 12000, maxLines: 80 },
  parameters: { type: "object", additionalProperties: false, required: ["operation"], properties: {
    operation: { type: "string", enum: ["context", "adopt", "deviate", "block", "expand", "correct"] },
    situation: { type: "string", maxLength: 1000 }, opportunityId: { type: "string", maxLength: MAX_OBSERVATION_ID_CHARS },
    features: { type: "object", propertyNames: { maxLength: MAX_FEATURE_KEY_CHARS },
      additionalProperties: { type: "string", maxLength: MAX_FEATURE_VALUE_CHARS }, maxProperties: MAX_OBSERVATION_FEATURES },
    versionId: { type: "string", maxLength: 200 }, scopeId: { type: "string", maxLength: 200 },
    trial: { type: "object", additionalProperties: false, required: ["versionId", "scopeId"], properties: {
      versionId: { type: "string", maxLength: 200 }, scopeId: { type: "string", maxLength: 200 },
    } },
    reason: { type: "string", maxLength: 1000 }, step: { type: "string", maxLength: 300 }, facts: { type: "string", maxLength: 1000 },
    observationId: { type: "string", maxLength: MAX_OBSERVATION_ID_CHARS }, outcome: { type: "string", enum: ["helped", "unhelpful", "unknown", "external_failure"] },
    application: { type: "object", additionalProperties: false, required: ["practice", "result"], properties: {
      practice: { type: "string", maxLength: MAX_APPLICATION_REPORT_CHARS }, result: { type: "string", maxLength: MAX_APPLICATION_REPORT_CHARS },
    } },
  } },
};

type Operation = { readonly kind: "context"; readonly situation: string; readonly opportunityId: string;
    readonly features: Readonly<Record<string, string>>; readonly trial?: ExperienceSourceTrial }
  | { readonly kind: "expand"; readonly versionId: string }
  | ({ readonly kind: "correct" } & Parameters<ExperienceRuntimePort["correct"]>[0])
  | { readonly kind: "decision"; readonly versionId: string; readonly scopeId: string; readonly action: "adopt" | "deviate" | "block";
      readonly reason: string; readonly step?: string; readonly facts?: string };

/** The host fixes the task identity. The model can describe a new opportunity, never impersonate another task. */
export function createExperienceTools(options: { readonly runtime: ExperienceRuntimePort; readonly taskId: string }): ToolPort {
  return {
    snapshot: () => [BINDING],
    cancel: async () => {},
    async execute(call, signal) {
      if (signal.aborted) return { outcome: "cancelled" };

      if (call.name !== METHOD_CONTEXT_TOOL) return failure("method_tool_unknown");

      const operation = readOperation(call.arguments, options.taskId);
      if (operation === undefined) return failure("method_context_invalid");

      try {
        const performed = await perform(options, operation);
        if (signal.aborted) return { outcome: "cancelled" };
        const value = operation.kind === "context" ? boundedContextResult(performed) : performed;
        if (value === undefined) return failure("method_context_unavailable");
        return signal.aborted ? { outcome: "cancelled" } : { outcome: "result", value, output: JSON.stringify(value), truncated: false };
      } catch {
        // A failed learning write or lookup cannot fail the business task or claim that adoption was recorded.
        return failure("method_context_unavailable");
      }
    },
  };
}

async function perform(options: { readonly runtime: ExperienceRuntimePort; readonly taskId: string }, operation: Operation): Promise<JsonObject> {
  if (operation.kind === "correct") {
    const { kind: _kind, ...correction } = operation;
    await options.runtime.correct(correction);
    return { status: "corrected", observationId: operation.observationId, outcome: operation.outcome,
      next: "The existing observation was revised with its original source authority. Resume planning with the updated method state." };
  }

  if (operation.kind === "context") {
    const selected = await options.runtime.context({ taskId: options.taskId, opportunityId: operation.opportunityId,
      situation: operation.situation, features: operation.features }, operation.trial);
    // The compact text is injected once at the next planning request. Repeating it in the tool result doubles context cost.
    return { status: "context_ready", selected: selected.map(item => ({ versionId: item.versionId, scopeId: item.scopeId,
      compilationId: item.compilationId, stable: item.stable,
      ...(item.adoptionWindowClosed ? { adoptionWindowClosed: true } : {}) })),
      next: nextContextAction(selected, options.runtime.takeContextConditions?.() ?? [], operation.trial) };
  }

  if (operation.kind === "expand") return { status: "expanded", versionId: operation.versionId, method: await options.runtime.expand(operation.versionId) };

  const { kind: _kind, ...decision } = operation;

  await options.runtime.decide(decision);

  return { status: "recorded", action: operation.action, versionId: operation.versionId,
    next: operation.action === "block" ? "This version is disabled for this task. Resume normal analysis or choose another method without waiting for learning." : "Continue the task." };
}

function nextContextAction(selected: readonly ExperienceSelection[], conditions: readonly ExperienceConditionRequest[], trial?: ExperienceSourceTrial): JsonObject {
  if (selected.length === 0 && conditions.length > 0) return {
    phase: "clarify_scope_facts", conditions: conditions.map(item => ({ versionId: item.versionId, scopeId: item.scopeId,
      condition: item.condition, missing: item.missing.map(literal => ({ ...literal })) })),
    instruction: "尚缺登记范围要求的事实，不是已证明不适用。先依据实际任务判断这些条件，再调用method_context(operation=context)：保留实际situation/opportunityId，把已知条件写入features的确切feature键。required成立时用expectedValue，明确不成立时用实际不同值；excluded同样填写实际值。未知不要猜或自动填yes；仍未知则正常分析，不反复请求相同缺失条件。",
    nextCall: { name: METHOD_CONTEXT_TOOL, argumentsToPreserve: ["situation", "opportunityId"],
      operation: "context", ...(trial === undefined ? {} : { trial: { ...trial } }), update: "features only with model-established task facts" },
    sourceTrial: SOURCE_TRIAL_RULE,
  };

  if (selected.length === 0) return { phase: "normal_planning",
    instruction: "没有匹配方法，继续正常分析；不要伪造adopt或方法反馈。情境改变时再调用context。", sourceTrial: SOURCE_TRIAL_RULE };

  return {
    phase: "after_next_method_slot_before_business_execution",
    instruction: selected.every(item => item.adoptionWindowClosed) ?
      "本父任务已结算业务而未预先采用，采用窗口已关闭。正常继续，不补adopt或方法帮助反馈；仍可记录deviate/block。" :
      "先等待下一次规划请求真实显示所选方法槽。阅读适用条件后，在执行任何业务步骤前逐项调用以下工具；必须把reason占位句替换为本任务的实际采用理由。context返回本身不等于采用。",
    sourceTrial: SOURCE_TRIAL_RULE,
    calls: selected.filter(item => !item.adoptionWindowClosed).map(item => ({ name: METHOD_CONTEXT_TOOL, arguments: {
      operation: "adopt", versionId: item.versionId, scopeId: item.scopeId, reason: "<填写本任务实际采用该方法的具体理由>",
    } })),
    ifInapplicable: { operation: "deviate", instruction: "若所选方法不适用，沿用对应versionId和scopeId，将operation改为deviate并填写实际偏离reason，然后正常分析。" },
    feedback: { fence: "trylo-method-feedback",
      rule: "任务回答结束时，仅对已真实显示且实际采用的方法反馈：使用该方法槽显示的m ref（不能用versionId代替），有帮助报helped:true，无帮助报helped:false；未知或未采用不报。不要因context返回或adopt成功而编造帮助。",
      format: { items: [{ ref: "<方法槽实际显示的m ref>", helped: true }] },
    },
  };
}

function readOperation(value: JsonObject, taskId: string): Operation | undefined {
  const allowed = ["operation", "situation", "opportunityId", "features", "versionId", "scopeId", "reason", "step", "facts", "observationId", "outcome", "trial", "application"];
  if (Object.keys(value).some(key => !allowed.includes(key))) return undefined;

  if (value.trial !== undefined && value.operation !== "context") return undefined;

  if (value.application !== undefined && value.operation !== "correct") return undefined;

  if (value.operation === "correct") {
    const outcome = value.outcome;
    if (!text(value.observationId, MAX_OBSERVATION_ID_CHARS) || !text(value.reason, 1000) ||
      (outcome !== "helped" && outcome !== "unhelpful" && outcome !== "unknown" && outcome !== "external_failure") ||
      (value.application !== undefined && !isMethodApplicationReport(value.application))) return undefined;
    return { kind: "correct", observationId: value.observationId, reason: value.reason, outcome,
      ...(value.application === undefined ? {} : { application: value.application }) };
  }

  if (value.operation === "context") {
    const context = { taskId, situation: value.situation, features: value.features, opportunityId: value.opportunityId ?? taskId };
    if (!isContext(context)) return undefined;
    const trial = readTrial(value.trial);
    if (value.trial !== undefined && trial === undefined) return undefined;
    return { kind: "context", situation: context.situation, features: context.features, opportunityId: context.opportunityId,
      ...(trial === undefined ? {} : { trial }) };
  }

  if (!text(value.versionId, 200)) return undefined;

  if (value.operation === "expand") return { kind: "expand", versionId: value.versionId };

  if (!["adopt", "deviate", "block"].includes(String(value.operation)) || !text(value.scopeId, 200) || !text(value.reason, 1000)) return undefined;

  if ((value.step !== undefined && !text(value.step, 300)) || (value.facts !== undefined && !text(value.facts, 1000))) return undefined;

  return { kind: "decision", versionId: value.versionId, scopeId: value.scopeId,
    action: value.operation as "adopt" | "deviate" | "block", reason: value.reason,
    ...(value.step === undefined ? {} : { step: value.step }), ...(value.facts === undefined ? {} : { facts: value.facts }) };
}

function readTrial(value: unknown): ExperienceSourceTrial | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const trial = value as Record<string, unknown>;
  if (Object.keys(trial).length !== 2 || !text(trial.versionId, 200) || !text(trial.scopeId, 200)) return undefined;
  return { versionId: trial.versionId, scopeId: trial.scopeId };
}

function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }

function failure(code: string): ToolOutcome { return { outcome: "error", code, message: code }; }
