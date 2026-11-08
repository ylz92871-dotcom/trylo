import type { CheckInput, CheckRequirements } from "../domain/v2/contracts.js";
import { parseCheckInput, parseCheckRequirements, requirementDigest } from "../domain/v2/parse.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isJsonValue } from "../../../../domains/tool/evolution/parse.js";
import type { ToolCallRequest, ToolOutcome } from "../../../../../ports/tools.js";
import type { JsonObject, JsonValue } from "../../../../../protocol/envelope.js";
import type { DailyCheckRun } from "./turn-contracts.js";

export function requirementsForCheckTask(input: { readonly text: string; readonly responseSchema?: JsonObject; readonly projectMessages?: readonly { readonly content: string }[] }) {
  const schema = input.responseSchema;
  const project = input.projectMessages?.map(message => message.content).join("\n") ?? "";
  const text = schema === undefined ? input.text : [typeof schema.description === "string" ? schema.description : "Satisfy the frozen output schema.",
    project, `Task instruction:\n${input.text}`].filter(Boolean).join("\n");
  const digest = requirementDigest({ text, ...(schema === undefined ? {} : { schema }) });
  const ref = schema === undefined ? `instruction:${digest}` : typeof schema.$id === "string" && schema.$id.trim().length > 0 ? schema.$id : `schema:${contentHashOf(schema)}`;

  return parseCheckRequirements({ ref, digest, text, ...(schema === undefined ? {} : { schema }) });
}

export function taskIdentity(input: { readonly text: string }, requirements: CheckRequirements): CheckInput["task"] {
  return { instruction: input.text, requirementRef: requirements.ref, requirementDigest: requirements.digest };
}

export function toolFacts(input: { readonly text: string }, requirements: CheckRequirements, call: ToolCallRequest, outcome: ToolOutcome) {
  const actual: JsonValue = outcome.outcome === "result" ? outcome.value : outcome.outcome === "error" || outcome.outcome === "unknown"
    ? { outcome: outcome.outcome, code: outcome.code, message: outcome.message } : { outcome: "cancelled" };
  const output = outcome.outcome === "result" && typeof outcome.value.content === "string" ? jsonOutput(outcome.value.content) : actual;
  return parseCheckInput({ task: taskIdentity(input, requirements), phase: "after_tool", tool: { name: call.name, args: call.arguments, result: actual }, output });
}

export function jsonOutput(text: string): JsonValue {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
  try {
    const parsed: unknown = JSON.parse(fenced?.[1] ?? trimmed);
    return isJsonValue(parsed) ? parsed : text;
  }
  catch { return text; }
}

export function formatRuns(runs: readonly DailyCheckRun[]): string {
  const visible = runs.slice(0, 2).map(run => ({ runId: run.runId, versionId: run.versionId,
    ...(run.outcome.kind !== "checked" ? run.outcome : { kind: "checked", verdict: {
      status: run.outcome.verdict.status, findings: run.outcome.verdict.findings.slice(0, 2).map(finding => ({
        requirementRef: finding.requirementRef, message: finding.message.slice(0, 160),
      })), additionalFindings: Math.max(0, run.outcome.verdict.findings.length - 2),
    } }),
  }));
  return `[Trylo learned checks] ${JSON.stringify({ runs: visible, additionalRuns: Math.max(0, runs.length - visible.length) })}`;
}
