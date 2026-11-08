import { checkerTargetFingerprint } from "./exposure.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { err, ok } from "../../../../../../tooling/contract/result.js";
import { isJsonValue, keysAre, recordOf } from "../../../../../domains/tool/evolution/parse.js";
import { CHECK_V2_LIMITS, type CheckEvaluation, type CheckEvaluationCase, type CheckSample,
  type CheckV2Result, type EvaluateCheckerInput, type LearnedChecker } from "./contracts.js";
import { checkInputJson, checkerAsToolCandidate, checkerMatches, parseCheckerVerdict, parseCheckSample, parseLearnedChecker } from "./parse.js";

/** Frozen caller-owned gold cases establish effectiveness. Generated self-reports and task completion never do. */
export async function evaluateChecker(input: EvaluateCheckerInput): Promise<CheckV2Result<CheckEvaluation>> {
  const candidate = parseLearnedChecker(input.candidate);
  if (!candidate.ok) return candidate;

  const corpus = parseCorpus(input.samples);
  if (!corpus.ok) return corpus;

  const checker = candidate.value, samples = corpus.value;
  const cases: CheckEvaluationCase[] = [];

  for (const sample of samples) {
    if (input.signal.aborted) return ok(summarize("cancelled", checker, samples, cases));
    const row = await checkOne(input, checker, sample);
    cases.push(row);
    if (row.outcome.kind === "cancelled") return ok(summarize("cancelled", checker, samples, cases));
  }

  const status = cases.some(row => row.outcome.kind === "checker_error") ? "incomplete"
    : cases.some(row => row.outcome.kind === "mismatch") ? "rejected" : "supported";

  return ok(summarize(status, checker, samples, cases));
}

function parseCorpus(raw: unknown): CheckV2Result<readonly CheckSample[]> {
  if (!Array.isArray(raw) || raw.length < 4 || raw.length > CHECK_V2_LIMITS.samples) {
    return err("invalid_corpus", "evaluation needs bounded source and unseen holdout cases");
  }

  const samples: CheckSample[] = [];

  for (const row of raw) {
    const parsed = parseCheckSample(row);
    if (!parsed.ok) return parsed;
    samples.push(parsed.value);
  }

  if (new Set(samples.map(row => row.id)).size !== samples.length
    || new Set(samples.map(row => checkerTargetFingerprint(row.input))).size !== samples.length
    || !["source", "holdout"].every(role => ["pass", "fail"].every(expected => samples.some(row => row.role === role && row.expected === expected)))) {
    return err("invalid_corpus", "source and holdout each need independent correct and incorrect cases with unique identities");
  }

  const training = new Set(samples.filter(row => row.role === "source").map(row => contentHashOf(row.input)));
  if (samples.some(row => row.role === "holdout" && training.has(contentHashOf(row.input)))) {
    return err("invalid_corpus", "holdout input appeared in the generator's source set");
  }

  return ok(samples);
}

/** Persisted evidence must prove the same exact coverage and arithmetic as a live evaluation. */
export function validateCheckEvaluation(raw: unknown, rawSamples: unknown, candidate: LearnedChecker): boolean {
  if (!isJsonValue(raw) || !recordOf(raw)
    || !keysAre(raw, ["status", "candidateHash", "samplesHash", "cases", "falsePositives", "falseNegatives", "checkerErrors"])
    || !["supported", "rejected", "incomplete", "cancelled"].includes(String(raw.status)) || !Array.isArray(raw.cases)) return false;

  const parsed = parseLearnedChecker(candidate), corpus = parseCorpus(rawSamples);
  if (!parsed.ok || !corpus.ok || raw.cases.length > corpus.value.length
    || (raw.status !== "cancelled" && raw.cases.length !== corpus.value.length)) return false;

  const cases: CheckEvaluationCase[] = [];

  for (let index = 0; index < raw.cases.length; index += 1) {
    const sample = corpus.value[index];
    if (sample === undefined) return false;
    const row = decodeEvaluationCase(raw.cases[index], sample, parsed.value);
    if (row === undefined) return false;
    if (row.outcome.kind === "cancelled" && (raw.status !== "cancelled" || index !== raw.cases.length - 1)) return false;
    cases.push(row);
  }

  const status = raw.status === "cancelled" ? "cancelled" : cases.some(row => row.outcome.kind === "checker_error") ? "incomplete"
    : cases.some(row => row.outcome.kind === "mismatch") ? "rejected" : "supported";

  return contentHashOf(raw) === contentHashOf(summarize(status, parsed.value, corpus.value, cases));
}

function decodeEvaluationCase(raw: unknown, sample: CheckSample, checker: LearnedChecker): CheckEvaluationCase | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["sampleId", "role", "expected", "execution", "outcome"])
    || raw.sampleId !== sample.id || raw.role !== sample.role || raw.expected !== sample.expected
    || (raw.execution !== "executed" && raw.execution !== "not_applicable") || !recordOf(raw.outcome)) return undefined;

  const applicable = checkerMatches(checker, sample.input, checker.applicability.scope);
  if ((raw.execution === "executed") !== applicable) return undefined;

  const base: Pick<CheckEvaluationCase, "sampleId" | "role" | "expected" | "execution"> = {
    sampleId: sample.id, role: sample.role, expected: sample.expected, execution: raw.execution };
  const outcome = raw.outcome;
  if (outcome.kind === "matched" || outcome.kind === "mismatch") {
    if (!keysAre(outcome, ["kind", "verdict"])) return undefined;
    const verdict = parseCheckerVerdict(outcome.verdict);
    if (!verdict.ok || (outcome.kind === "matched") !== (verdict.value.status === sample.expected)
      || verdict.value.findings.some(finding => finding.requirementRef !== sample.input.task.requirementRef)
      || (raw.execution === "not_applicable" && verdict.value.status !== "not_applicable")) return undefined;
    return { ...base, outcome: { kind: outcome.kind, verdict: verdict.value } };
  }

  if (raw.execution !== "executed") return undefined;

  if (outcome.kind === "cancelled" && keysAre(outcome, ["kind"])) return { ...base, outcome: { kind: "cancelled" } };

  if (outcome.kind !== "checker_error" || !keysAre(outcome, ["kind", "code"])) return undefined;

  const code = (["tool_error", "timeout", "protocol_error", "unavailable", "invalid_verdict", "executor_threw"] as const).find(value => value === outcome.code);

  return code === undefined ? undefined : { ...base, outcome: { kind: "checker_error", code } };
}

async function checkOne(input: EvaluateCheckerInput, checker: LearnedChecker, sample: CheckSample): Promise<CheckEvaluationCase> {
  const base = { sampleId: sample.id, role: sample.role, expected: sample.expected };

  if (!checkerMatches(checker, sample.input, checker.applicability.scope)) {
    return { ...base, execution: "not_applicable", outcome: { kind: sample.expected === "not_applicable" ? "matched" : "mismatch",
      verdict: { status: "not_applicable", findings: [] } } };
  }

  try {
    const executed = await input.executor.execute(checkerAsToolCandidate(checker), checkInputJson(sample.input), input.signal);
    if (input.signal.aborted || executed.kind === "cancelled") return { ...base, execution: "executed", outcome: { kind: "cancelled" } };

    if (executed.kind !== "value") return { ...base, execution: "executed", outcome: { kind: "checker_error", code: executed.kind } };

    const verdict = parseCheckerVerdict(executed.value);
    if (!verdict.ok || verdict.value.findings.some(finding => finding.requirementRef !== sample.input.task.requirementRef)) {
      return { ...base, execution: "executed", outcome: { kind: "checker_error", code: "invalid_verdict" } };
    }

    return { ...base, execution: "executed", outcome: { kind: verdict.value.status === sample.expected ? "matched" : "mismatch", verdict: verdict.value } };
  } catch {
    return { ...base, execution: "executed", outcome: input.signal.aborted ? { kind: "cancelled" } : { kind: "checker_error", code: "executor_threw" } };
  }
}

function summarize(status: CheckEvaluation["status"], checker: LearnedChecker, samples: readonly CheckSample[], cases: readonly CheckEvaluationCase[]): CheckEvaluation {
  return { status, candidateHash: contentHashOf(checker), samplesHash: contentHashOf(samples), cases,
    falsePositives: cases.filter(row => row.outcome.kind === "mismatch" && row.expected !== "fail" && row.outcome.verdict.status === "fail").length,
    falseNegatives: cases.filter(row => row.outcome.kind === "mismatch" && row.expected === "fail" && row.outcome.verdict.status !== "fail").length,
    checkerErrors: cases.filter(row => row.outcome.kind === "checker_error").length };
}
