import type { JsonObject, JsonValue } from "../../../../../../protocol/envelope.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { err, ok } from "../../../../../../tooling/contract/result.js";
import { isJsonValue, jsonBytes, keysAre, parseToolEvolutionCandidate, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import type { ToolEvolutionCandidate } from "../../../../../domains/tool/evolution/contracts.js";
import { CHECK_V2_LIMITS, type CheckExperience, type CheckInput, type CheckRequirements, type CheckSample,
  type CheckerVerdict, type CheckV2Result, type LearnedChecker } from "./contracts.js";

export function requirementDigest(requirements: Pick<CheckRequirements, "text" | "schema">): string {
  return contentHashOf({ text: requirements.text, ...(requirements.schema === undefined ? {} : { schema: requirements.schema }) });
}

export function parseCheckRequirements(raw: unknown): CheckV2Result<CheckRequirements> {
  if (!boundedJson(raw, 32_768) || !recordOf(raw) || !keysAre(raw, ["ref", "digest", "text"], ["schema"])
    || !textOf(raw.ref, 512) || !digest(raw.digest) || !textOf(raw.text, 8192)
    || (raw.schema !== undefined && (!recordOf(raw.schema) || !isJsonValue(raw.schema)))) {
    return err("invalid_requirements", "requirements need a bounded immutable ref, text, digest and optional schema");
  }

  const value: CheckRequirements = { ref: raw.ref, digest: raw.digest, text: raw.text,
    ...(raw.schema === undefined ? {} : { schema: raw.schema as JsonObject }) };

  return requirementDigest(value) === value.digest ? ok(structuredClone(value))
    : err("invalid_requirements", "requirement digest does not cover this exact text and schema");
}

export function parseCheckInput(raw: unknown): CheckV2Result<CheckInput> {
  if (!boundedJson(raw, CHECK_V2_LIMITS.inputBytes) || !recordOf(raw)
    || !keysAre(raw, ["task", "phase", "output"], ["tool"]) || !recordOf(raw.task)
    || !keysAre(raw.task, ["instruction", "requirementRef", "requirementDigest"])
    || !textOf(raw.task.instruction, 8192) || !textOf(raw.task.requirementRef, 512) || !digest(raw.task.requirementDigest)
    || !phase(raw.phase) || (raw.phase === "after_tool" && raw.tool === undefined)) {
    return err("invalid_input", "check input needs a frozen task requirement and explicit execution phase");
  }

  const tool = raw.tool;
  if (tool !== undefined && (!recordOf(tool) || !keysAre(tool, ["name", "args", "result"])
    || !textOf(tool.name, 128) || !recordOf(tool.args) || !isJsonValue(tool.args) || !isJsonValue(tool.result))) {
    return err("invalid_input", "tool facts must be a bounded name, JSON arguments and actual result");
  }

  return ok(structuredClone(raw) as CheckInput);
}

export function parseCheckExperience(raw: unknown): CheckV2Result<CheckExperience> {
  if (!boundedJson(raw, CHECK_V2_LIMITS.experienceBytes) || !recordOf(raw)
    || !keysAre(raw, ["schemaVersion", "type", "id", "scope", "sessionId", "turnId", "requirements", "facts", "priorRuns"], ["assessment"])
    || raw.schemaVersion !== 2 || raw.type !== "check_experience" || !textOf(raw.id, 256) || !textOf(raw.scope, 512)
    || !textOf(raw.sessionId, 160) || !textOf(raw.turnId, 160) || !strings(raw.priorRuns, 0, 32, 256)) {
    return err("invalid_experience", "experience must have v2 shape, causal task coordinates and bounded history");
  }

  const requirements = parseCheckRequirements(raw.requirements), facts = parseCheckInput(raw.facts);
  if (!requirements.ok) return requirements;

  if (!facts.ok) return facts;

  if (facts.value.task.requirementRef !== requirements.value.ref || facts.value.task.requirementDigest !== requirements.value.digest) {
    return err("invalid_experience", "experience facts must bind the exact immutable requirements");
  }

  const assessment = raw.assessment;
  if (assessment !== undefined && (!recordOf(assessment) || !keysAre(assessment, ["verdict", "sourceRef", "kind"])
    || !["valid", "invalid", "not_applicable"].includes(String(assessment.verdict)) || !textOf(assessment.sourceRef, 512)
    || (assessment.kind !== "task_oracle" && assessment.kind !== "user_correction"))) {
    return err("invalid_experience", "assessment must cite a task oracle or explicit correction, never task completion alone");
  }

  return ok({ schemaVersion: 2, type: "check_experience", id: raw.id, scope: raw.scope, sessionId: raw.sessionId, turnId: raw.turnId,
    requirements: requirements.value, facts: facts.value, priorRuns: [...raw.priorRuns],
    ...(assessment === undefined ? {} : { assessment: structuredClone(assessment) as NonNullable<CheckExperience["assessment"]> }) });
}

/** Parsing never interprets model text as a verdict, permission or modification of the requirement oracle. */
export function parseLearnedChecker(input: unknown): CheckV2Result<LearnedChecker> {
  let raw = input;
  if (typeof raw === "string") {
    if (raw.length > CHECK_V2_LIMITS.candidateBytes) return err("invalid_checker", "candidate text exceeds its bound");
    try { raw = JSON.parse(raw) as unknown; }
    catch { return err("invalid_checker", "candidate must contain one JSON object"); }
  }

  if (!boundedJson(raw, CHECK_V2_LIMITS.candidateBytes) || !recordOf(raw)
    || !keysAre(raw, ["schemaVersion", "type", "question", "claim", "applicability", "timing", "source", "sourceRefs"], ["parentVersionId"])
    || raw.schemaVersion !== 2 || raw.type !== "learned_checker" || !textOf(raw.question, 600) || !textOf(raw.claim, 1200)
    || !textOf(raw.source) || new TextEncoder().encode(raw.source).length > CHECK_V2_LIMITS.sourceBytes
    || raw.source.includes("\0") || !/^\s*module\s*\.\s*exports\s*=\s*/u.test(raw.source)
    || !strings(raw.sourceRefs, 1, CHECK_V2_LIMITS.sourceRefs, 512)
    || !Array.isArray(raw.timing) || raw.timing.length < 1 || raw.timing.length > 2 || !raw.timing.every(phase)
    || new Set(raw.timing).size !== raw.timing.length || !applicability(raw.applicability)
    || (raw.parentVersionId !== undefined && !textOf(raw.parentVersionId, 256))) {
    return err("invalid_checker", "checker must have exact v2 shape, bounded source and locally evaluable conditions");
  }

  const checker = structuredClone(raw) as LearnedChecker;
  const tool = parseToolEvolutionCandidate(JSON.stringify(checkerAsToolCandidate(checker)));

  return tool.ok ? ok(checker) : err("invalid_checker", tool.message);
}

export function parseCheckSample(raw: unknown): CheckV2Result<CheckSample> {
  if (!boundedJson(raw, CHECK_V2_LIMITS.inputBytes + 2048) || !recordOf(raw)
    || !keysAre(raw, ["id", "role", "input", "expected", "oracle"]) || !textOf(raw.id, 256)
    || (raw.role !== "source" && raw.role !== "holdout") || !status(raw.expected) || !recordOf(raw.oracle)
    || !keysAre(raw.oracle, ["kind", "sourceRef", "requirementDigest"])
    || (raw.oracle.kind !== "task_oracle" && raw.oracle.kind !== "user_correction")
    || !textOf(raw.oracle.sourceRef, 512) || !digest(raw.oracle.requirementDigest)) {
    return err("invalid_sample", "samples require caller-owned labels and independent oracle coordinates");
  }

  const input = parseCheckInput(raw.input);
  if (!input.ok || input.value.task.requirementDigest !== raw.oracle.requirementDigest) {
    return err("invalid_sample", "sample label is not bound to the exact task requirement");
  }

  return ok({ id: raw.id, role: raw.role, input: input.value, expected: raw.expected,
    oracle: { kind: raw.oracle.kind, sourceRef: raw.oracle.sourceRef, requirementDigest: raw.oracle.requirementDigest } });
}

export function parseCheckerVerdict(raw: unknown): CheckV2Result<CheckerVerdict> {
  if (!boundedJson(raw, 16_384) || !recordOf(raw) || !keysAre(raw, ["status", "findings"])
    || !status(raw.status) || !Array.isArray(raw.findings) || raw.findings.length > CHECK_V2_LIMITS.findings
    || !raw.findings.every(finding => recordOf(finding) && keysAre(finding, ["requirementRef", "message"])
      && textOf(finding.requirementRef, 512) && textOf(finding.message, 512))
    || (raw.status === "fail" ? raw.findings.length === 0 : raw.findings.length !== 0)) {
    return err("invalid_verdict", "checker output must distinguish pass/fail/not_applicable and provide requirement-linked failures");
  }
  return ok(structuredClone(raw) as CheckerVerdict);
}

export function checkerMatches(candidate: LearnedChecker, input: CheckInput, scope: string): boolean {
  const when = candidate.applicability;
  if (when.scope !== scope || when.requirementRef !== input.task.requirementRef
    || when.requirementDigest !== input.task.requirementDigest || !candidate.timing.includes(input.phase)
    || !when.instructionIncludes.every(fragment => input.task.instruction.includes(fragment))) return false;

  const output = recordOf(input.output) ? input.output : undefined;

  return when.requiredKeys.every(key => output !== undefined && Object.hasOwn(output, key))
    && when.excludedKeys.every(key => output === undefined || !Object.hasOwn(output, key));
}

/** The existing executor supplies process mechanics only. It is never the oracle for task quality. */
export function checkerAsToolCandidate(checker: LearnedChecker): ToolEvolutionCandidate {
  return { identity: "learned_checker", description: checker.claim, source: checker.source, inputSchema: { type: "object" },
    mastery: { whenToUse: [checker.question], preconditions: [checker.applicability.requirementRef], pitfalls: ["Task requirements and permissions remain with the host."] } };
}

/** Source identity is grounded in host facts; this checks coordinates, never the truth of a hypothesis. */
export function validateCheckerGrounding(checker: LearnedChecker, experiences: readonly CheckExperience[], feedbackRefs: readonly string[] = []): CheckV2Result<LearnedChecker> {
  const candidate = parseLearnedChecker(checker);
  if (!candidate.ok) return candidate;

  const records: CheckExperience[] = [];

  for (const raw of experiences) {
    const parsed = parseCheckExperience(raw);
    if (!parsed.ok) return parsed;
    records.push(parsed.value);
  }

  const when = candidate.value.applicability;
  const relevant = records.filter(record => record.scope === when.scope && record.requirements.ref === when.requirementRef
    && record.requirements.digest === when.requirementDigest);

  if (!strings(feedbackRefs, 0, 32, 512)) return err("unbound_checker", "feedback sources must be bounded host references");

  const refs = new Set([...feedbackRefs, ...relevant.flatMap(record => [record.id, record.requirements.ref,
    ...(record.assessment === undefined ? [] : [record.assessment.sourceRef])])]);

  return relevant.length > 0 && candidate.value.sourceRefs.every(ref => refs.has(ref)) ? candidate
    : err("unbound_checker", "candidate applicability and citations must resolve to the exact host-owned requirement evidence");
}

/** Structural JSON conversion keeps executor inputs bounded without an unchecked double assertion. */
export function checkInputJson(input: CheckInput): JsonObject {
  return { task: { ...input.task }, phase: input.phase, output: input.output,
    ...(input.tool === undefined ? {} : { tool: { name: input.tool.name, args: input.tool.args, result: input.tool.result } }) };
}

function applicability(raw: unknown): boolean {
  if (!recordOf(raw) || !keysAre(raw, ["scope", "requirementRef", "requirementDigest", "requiredKeys", "excludedKeys", "instructionIncludes"])) return false;
  const required = raw.requiredKeys, excluded = raw.excludedKeys;
  return textOf(raw.scope, 512) && textOf(raw.requirementRef, 512) && digest(raw.requirementDigest)
    && strings(required, 0, 16, 128) && strings(excluded, 0, 16, 128)
    && !required.some(key => excluded.includes(key)) && strings(raw.instructionIncludes, 0, 8, 256);
}

function boundedJson(raw: unknown, maxBytes: number): raw is JsonValue { return isJsonValue(raw, 20) && jsonBytes(raw) <= maxBytes; }

function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }

function phase(value: unknown): value is CheckInput["phase"] { return value === "after_tool" || value === "before_completion"; }

function status(value: unknown): value is CheckerVerdict["status"] { return value === "pass" || value === "fail" || value === "not_applicable"; }

function strings(raw: unknown, min: number, max: number, chars: number): raw is readonly string[] {
  return Array.isArray(raw) && raw.length >= min && raw.length <= max && raw.every(value => textOf(value, chars)) && new Set(raw).size === raw.length;
}
