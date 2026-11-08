import {
  CHECK_KINDS,
  EXTERNAL_VERDICT_KINDS,
  PROMPT_SECTIONS,
  VERDICT_RESULTS,
  type CheckKind,
  type ExternalVerdict,
  type PromptOp,
  type PromptSection,
  type TaskFamily,
  type TrajectorySketch,
  type VersionPins,
} from "./types.js";

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export function parseJsonValue(text: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "malformed json" };
  }
}

export function parseTaskFamily(value: unknown): ParseResult<TaskFamily> {
  if (!isRecord(value)) {
    return fail("taskFamily is not an object");
  }

  const id = requiredString(value, "id");
  const intentClass = requiredString(value, "intentClass");
  const checkKind = requiredString(value, "checkKind");

  if (!id.ok) {
    return id;
  }

  if (!intentClass.ok) {
    return intentClass;
  }

  if (!checkKind.ok) {
    return checkKind;
  }

  if (!isCheckKind(checkKind.value)) {
    return fail(`unknown checkKind: ${checkKind.value}`);
  }

  const family: TaskFamily = {
    id: id.value,
    intentClass: intentClass.value,
    checkKind: checkKind.value,
  };

  return {
    ok: true,
    value: withOptionalStrings(family, value, ["language", "repoKind", "checkSchema"]),
  };
}

export function parseVersionPins(value: unknown): ParseResult<VersionPins> {
  if (!isRecord(value)) {
    return fail("versions is not an object");
  }

  const model = requiredString(value, "model");
  const toolset = requiredString(value, "toolset");
  const codeBaseline = requiredString(value, "codeBaseline");
  const workflow = requiredString(value, "workflow");

  if (!model.ok) {
    return model;
  }

  if (!toolset.ok) {
    return toolset;
  }

  if (!codeBaseline.ok) {
    return codeBaseline;
  }

  if (!workflow.ok) {
    return workflow;
  }

  return {
    ok: true,
    value: {
      model: model.value,
      toolset: toolset.value,
      codeBaseline: codeBaseline.value,
      workflow: workflow.value,
    },
  };
}

export function parseExternalVerdict(value: unknown): ParseResult<ExternalVerdict> {
  if (!isRecord(value)) {
    return fail("external verdict is not an object");
  }

  const kind = requiredString(value, "kind");
  const result = requiredString(value, "result");
  const ref = requiredString(value, "ref");

  if (!kind.ok) {
    return kind;
  }

  if (!result.ok) {
    return result;
  }

  if (!ref.ok) {
    return ref;
  }

  if (!EXTERNAL_VERDICT_KINDS.includes(kind.value as ExternalVerdict["kind"])) {
    return fail(`unknown verdict kind: ${kind.value}`);
  }

  if (!VERDICT_RESULTS.includes(result.value as ExternalVerdict["result"])) {
    return fail(`unknown verdict result: ${result.value}`);
  }

  if (typeof value.selfGenerated !== "boolean") {
    return fail("selfGenerated must be boolean");
  }

  return {
    ok: true,
    value: {
      kind: kind.value as ExternalVerdict["kind"],
      result: result.value as ExternalVerdict["result"],
      ref: ref.value,
      selfGenerated: value.selfGenerated,
    },
  };
}

export function parsePromptOps(value: unknown): ParseResult<PromptOp[]> {
  if (!Array.isArray(value)) {
    return fail("candidatePatch must be an array");
  }

  const ops: PromptOp[] = [];

  for (const item of value) {
    const parsed = parsePromptOp(item);
    if (!parsed.ok) {
      return parsed;
    }
    ops.push(parsed.value);
  }

  return { ok: true, value: ops };
}

export function parsePromptOp(value: unknown): ParseResult<PromptOp> {
  if (!isRecord(value)) {
    return fail("prompt op is not an object");
  }

  const op = requiredString(value, "op");
  if (!op.ok) {
    return op;
  }

  if (op.value === "replace_section") {
    const section = requiredString(value, "section");
    const fromHash = requiredString(value, "fromHash");
    const toHash = requiredString(value, "toHash");

    if (!section.ok) {
      return section;
    }

    if (!fromHash.ok) {
      return fromHash;
    }

    if (!toHash.ok) {
      return toHash;
    }

    if (!isPromptSection(section.value)) {
      return fail(`unknown prompt section: ${section.value}`);
    }

    return {
      ok: true,
      value: {
        op: "replace_section",
        section: section.value,
        fromHash: fromHash.value,
        toHash: toHash.value,
      },
    };
  }

  if (op.value === "add_constraint") {
    const constraintHash = requiredString(value, "constraintHash");
    if (!constraintHash.ok) {
      return constraintHash;
    }
    return { ok: true, value: { op: "add_constraint", constraintHash: constraintHash.value } };
  }

  if (op.value === "reorder_context") {
    if (!Array.isArray(value.order) || value.order.some((item) => typeof item !== "string")) {
      return fail("reorder_context.order must be string[]");
    }
    return { ok: true, value: { op: "reorder_context", order: value.order } };
  }

  return fail(`unknown prompt op: ${op.value}`);
}

export function parseTrajectory(value: unknown): ParseResult<TrajectorySketch> {
  if (!isRecord(value)) {
    return fail("trajectory is not an object");
  }

  if (!Array.isArray(value.nodeIds) || value.nodeIds.some((item) => typeof item !== "string")) {
    return fail("nodeIds must be string[]");
  }

  if (typeof value.stepCount !== "number" || !Number.isFinite(value.stepCount)) {
    return fail("stepCount must be a number");
  }

  if (typeof value.hadFailureRecovery !== "boolean" || typeof value.hadChecks !== "boolean") {
    return fail("hadFailureRecovery and hadChecks must be boolean");
  }

  return {
    ok: true,
    value: {
      nodeIds: value.nodeIds,
      stepCount: value.stepCount,
      hadFailureRecovery: value.hadFailureRecovery,
      hadChecks: value.hadChecks,
    },
  };
}

export function parseEpisodeArray<T>(
  text: string,
  parseOne: (value: unknown) => ParseResult<T>,
): ParseResult<T[]> {
  const json = parseJsonValue(text);
  if (!json.ok) {
    return json;
  }

  if (!isRecord(json.value) || !Array.isArray(json.value.episodes)) {
    return fail("payload.episodes must be an array");
  }

  const episodes: T[] = [];

  for (const item of json.value.episodes) {
    const parsed = parseOne(item);
    if (!parsed.ok) {
      return parsed;
    }
    episodes.push(parsed.value);
  }

  return { ok: true, value: episodes };
}

function isCheckKind(value: string): value is CheckKind {
  return (CHECK_KINDS as readonly string[]).includes(value);
}

function isPromptSection(value: string): value is PromptSection {
  return (PROMPT_SECTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): ParseResult<string> {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    return fail(`${key} must be a non-empty string`);
  }
  return { ok: true, value: field };
}

function withOptionalStrings(
  family: TaskFamily,
  value: Record<string, unknown>,
  keys: readonly ("language" | "repoKind" | "checkSchema")[],
): TaskFamily {
  let next = family;

  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) {
      next = { ...next, [key]: field };
    }
  }

  return next;
}

function fail(reason: string): ParseResult<never> {
  return { ok: false, reason };
}
