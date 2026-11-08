import type { JsonObject, JsonValue } from "../../../../../protocol/envelope.js";

export const MAX_CONTEXT_RESULT_BYTES = 11000;
const OMISSION_NOTICE = "重复调用示例或部分待澄清范围因输出预算省略。仅对实际显示的selected ID记录adopt；未显示条件仍未解决。依据已显示的完整missing判断事实，仍未知则正常分析，不自动填yes或反复请求。";

/** The normal response is unchanged. On overflow, remove only complete optional
 * records: repeated call examples, then lowest-ranked condition records.
 * Canonical selected identities and literal values are never cut mid-record. */
export function boundedContextResult(value: JsonObject): JsonObject | undefined {
  if (bytesOf(value) <= MAX_CONTEXT_RESULT_BYTES) return value;

  const rawNext = value.next;
  if (!isObject(rawNext)) return undefined;

  const next: { [key: string]: JsonValue } = { ...rawNext };
  const result = { ...value, next };
  const calls = Array.isArray(next.calls) ? next.calls.length : 0;
  const conditions = Array.isArray(next.conditions) ? [...next.conditions] : [];
  const originalConditions = conditions.length;

  if (calls > 0) {
    delete next.calls;
    next.instruction = "先等待下一次规划请求真实显示所选方法槽，再用selected中的versionId/scopeId调用method_context(operation=adopt)，reason写本任务实际采用理由；不适用则deviate。context本身不等于采用。";
  }

  next.omitted = { calls, conditions: 0 };
  next.omissionNotice = OMISSION_NOTICE;

  if (bytesOf(result) <= MAX_CONTEXT_RESULT_BYTES) return result;

  while (conditions.length > 0) {
    conditions.pop();
    next.conditions = conditions;
    next.omitted = { calls, conditions: originalConditions - conditions.length };
    if (bytesOf(result) <= MAX_CONTEXT_RESULT_BYTES) return result;
  }

  // The remaining selection identity/instructions cannot be represented by a
  // valid bounded result. The caller returns its existing typed unavailability.
  return undefined;
}

function bytesOf(value: JsonObject): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
