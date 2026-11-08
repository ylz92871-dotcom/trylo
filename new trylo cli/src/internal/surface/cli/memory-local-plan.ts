import { comparableMemoryText, isStandaloneClaimSource, localMemoryClaim } from "../../integration/user-learning/memory-intent.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolOutcome } from "../../ports/tools.js";

export type MemoryCommandStep = { readonly name: "memory_search" | "memory_remember" | "memory_correct" | "memory_forget"; readonly arguments: JsonObject };

type MemoryReadSavePlan = {
  readonly kind: "save" | "identity" | "authorship";
  readonly steps: ReadonlyArray<MemoryCommandStep>;
};

export type MemoryRevisionPlan =
  | { readonly kind: "correct"; readonly statement: string; readonly steps: ReadonlyArray<MemoryCommandStep> }
  | { readonly kind: "retract"; readonly steps: ReadonlyArray<MemoryCommandStep> };

export type MemoryCommandPlan = MemoryReadSavePlan | MemoryRevisionPlan;

const IDENTITY_SEARCH: MemoryCommandStep = { name: "memory_search", arguments: { queries: [], record_kind: "identity_fact", max_results: 100 } };
const AUTHORSHIP_QUESTIONS = ["你是不是我开发的", "你是谁开发的是不是我", "你觉得你是谁开发的是不是我呢"];
const AUTHORSHIP_CLARIFICATION = "请区分Trylo产品和基础模型";

/** Identity mutation grammar is deliberately closed; quoting and mixed tasks remain model tasks. */
function revisionPlan(text: string): MemoryRevisionPlan | undefined {
  const correct = /^(?:请查正式记忆[，,])?把我(?:原来|之前)?那条(?:测试开发者)?身份(?:记忆)?(?:改正|更正|修改)为[：:](我(?:叫|是|的名字是)[^。.!！?？；;\n]+)[。.]?(?:请更正原记录[，,]不新增第二条[。.]?)?$/u.exec(text);
  if (correct !== null) {
    const claim = localMemoryClaim(`请记住：${correct[1]!.trim()}`);
    if (claim?.factKind === "identity_fact") return { kind: "correct", statement: claim.statement, steps: [IDENTITY_SEARCH] };
    return undefined;
  }

  if (["请查正式记忆忘掉并撤回我那条测试开发者身份", "请查正式记忆撤回我那条身份记忆", "请撤回我那条身份记忆", "请忘掉我的身份记忆"]
    .includes(comparableMemoryText(text))) return { kind: "retract", steps: [IDENTITY_SEARCH] };

  return undefined;
}

/** Only complete, standalone commands qualify. Embedded instructions remain model tasks. */
export function localMemoryPlan(text: string, previous?: string): MemoryCommandPlan | undefined {
  if (!isStandaloneClaimSource(text)) return undefined;

  const revision = revisionPlan(text);
  if (revision !== undefined) return revision;

  const searchThenSave = /^请先检索现有正式记忆，再记住[：:]([^\n`“”"「」]+?)[。.]?请报告实际保存结果[。.]?$/u.exec(text);
  const claim = localMemoryClaim(searchThenSave === null ? text : `请记住：${searchThenSave[1]!}`, previous);
  if (claim !== undefined) return {
    kind: "save", steps: [
      ...(searchThenSave === null ? [] : [{ name: "memory_search" as const, arguments: { queries: [] } }]),
      { name: "memory_remember", arguments: { subject: claim.subject, statement: claim.statement, fact_kind: claim.factKind, scope: claim.scopeKind } },
    ],
  };

  const question = isStandaloneClaimSource(text) ? comparableMemoryText(text) : "";
  if (["你知道我是谁吗", "我是谁", "你记得我是谁吗"].includes(question)) {
    return { kind: "identity", steps: [IDENTITY_SEARCH] };
  }

  if (AUTHORSHIP_QUESTIONS.some(base => question === base || question === `${base}${AUTHORSHIP_CLARIFICATION}`)
    || question === "你是不是我开发的请先查正式记忆分别回答Trylo产品和基础模型") {
    return { kind: "authorship", steps: [IDENTITY_SEARCH] };
  }

  return undefined;
}

export type MemoryRevisionSelection =
  | { readonly kind: "ready"; readonly step: MemoryCommandStep }
  | { readonly kind: "refused"; readonly message: string };

/** Pair the authoritative metadata line with its statement. IDs are never guessed from document_id. */
export function memoryRevisionSelection(plan: MemoryRevisionPlan, outcome: ToolOutcome): MemoryRevisionSelection {
  const refused = { kind: "refused" as const, message: `尚未${plan.kind === "correct" ? "更正" : "撤回"}：未检索到唯一、完整的身份目标，请明确要操作的记录。` };

  if (outcome.outcome !== "result" || outcome.truncated || outcome.value["truncated"] !== false || outcome.value["nextCursor"] !== undefined) return refused;

  const documents = outcome.value["documents"];
  if (!Array.isArray(documents) || documents.length !== 2 || outcome.value["matchCount"] !== 2) return refused;

  const lines = documents.filter((document): document is JsonObject => document !== null && typeof document === "object" && !Array.isArray(document));
  if (lines.length !== 2 || lines.some(document => document["origin"] !== "user-memory" || document["recordKind"] !== "identity_fact")) return refused;

  const statement = lines.find(document => document["matchLineNumber"] === 1);
  const metadata = lines.find(document => document["matchLineNumber"] === 2);
  if (statement === undefined || metadata === undefined || typeof statement["content"] !== "string"
    || typeof metadata["content"] !== "string" || statement["documentId"] !== metadata["documentId"]) return refused;

  const match = /^record_id: ([A-Za-z0-9_-]{1,200}); expected_version: ([1-9][0-9]*); 类别：identity_fact；作用域：(user|project):[^\r\n]+$/u.exec(metadata["content"]);
  if (match === null || statement["documentId"] !== `user-memory:${match[1]}`
    || metadata["path"] !== `trylo://learning/user/${match[1]}` || statement["path"] !== metadata["path"]) return refused;

  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) return refused;

  return { kind: "ready", step: { name: plan.kind === "correct" ? "memory_correct" : "memory_forget",
    arguments: { record_id: match[1]!, expected_version: version, ...(plan.kind === "correct" ? { statement: plan.statement } : {}) } } };
}

export function memoryCommandReply(plan: MemoryCommandPlan, outcome: ToolOutcome | undefined, enabled: boolean): string {
  const action = plan.kind === "correct" ? "更正" : plan.kind === "retract" ? "撤回" : "保存或读取记忆";

  if (!enabled) return `当前未${action}：用户学习未开启。`;

  if (outcome?.outcome !== "result") {
    return outcome?.outcome === "error" ? `记忆操作失败，未${action}：${outcome.message}` : `尚未${action}：工具未获执行许可或本轮不可用。`;
  }

  if (plan.kind === "save" || plan.kind === "correct" || plan.kind === "retract") return outcome.output;

  const documents = outcome.value["documents"];
  const statements = Array.isArray(documents) ? documents.flatMap((document) => {
    if (document === null || typeof document !== "object" || Array.isArray(document)) return [];
    return document["origin"] === "user-memory" && document["recordKind"] === "identity_fact" && document["matchLineNumber"] === 1 && typeof document["content"] === "string"
      ? [document["content"].split("\n")[0]!] : [];
  }) : [];
  const evidence = (statements.length === 0 ? "当前正式用户记忆中没有可用的身份记录。"
    : `已检索正式用户记忆，其中记录的用户陈述：\n${statements.map((statement) => `- ${statement}`).join("\n")}`
  ) + (outcome.truncated ? "\n本页仅展示部分记录，可以继续检索剩余记录。" : "");

  return plan.kind === "identity" ? evidence
    : `${evidence}\n关于 Trylo 产品：仅能参考记录中明确的产品开发自述，不能从姓名或偏好推断开发者身份。\n关于基础模型：仅凭产品开发者身份，无法确认基础模型由你训练、开发或拥有；该记录也不授予任何权限。`;
}
