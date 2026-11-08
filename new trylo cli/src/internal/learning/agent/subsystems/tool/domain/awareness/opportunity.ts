import { isDigest } from "../evolution/artifact.js";
import { isJsonValue, jsonBytes, keysAre, parseToolEvolutionSample, recordOf, textOf } from "../evolution/parse.js";
import { TOOL_USE_EXECUTIONS } from "../evolution/use.js";
import type { ToolEvolutionSample } from "../evolution/contracts.js";
import { decodeToolObservedCapability, type ToolObservedCapability } from "./observed-catalog.js";
import { decodeToolTaskText, type ToolTaskText } from "./task-text.js";

/** Execution facts are supplied by the host; the model can only refer to their IDs. */
export type ToolExecutionFact = {
  readonly tool: string;
  readonly toolCallId: string;
  readonly versionId?: string;
  readonly inputHash?: string;
  readonly outputHash?: string;
  readonly execution: (typeof TOOL_USE_EXECUTIONS)[number];
  readonly durationMs?: number;
};

export type ToolOpportunityReport = {
  readonly kind: "opportunity";
  readonly need: string;
  readonly reason: string;
  readonly tool?: string;
  readonly toolCallIds: readonly string[];
  readonly existingCapability: "insufficient" | "configuration_sufficient" | "unknown";
  readonly expectedBenefit?: string;
};

export type ToolOpportunitySource = "model" | "user" | "personal_agent" | "collaboration";

export type ToolOpportunityGrounding = {
  readonly source: "user_contract" | "tool_contract" | "observed_io";
  readonly reference: string;
  readonly samples: readonly ToolEvolutionSample[];
};

export type ToolOpportunityEvidence = {
  readonly reportId: string;
  readonly source: ToolOpportunitySource;
  readonly assessment: ToolOpportunityReport;
  readonly executions: readonly ToolExecutionFact[];
  readonly grounding?: ToolOpportunityGrounding;
  readonly catalog?: readonly ToolObservedCapability[];
  readonly task?: ToolTaskText;
};

export function decodeToolExecutionFact(value: unknown): ToolExecutionFact | undefined {
  if (!recordOf(value) || !isJsonValue(value) || !keysAre(value, ["tool", "toolCallId", "execution"],
    ["versionId", "inputHash", "outputHash", "durationMs"]) || !textOf(value.tool, 256) || !textOf(value.toolCallId, 256)
    || !TOOL_USE_EXECUTIONS.some(kind => kind === value.execution)
    || (value.versionId !== undefined && !textOf(value.versionId, 160))
    || (value.inputHash !== undefined && !isDigest(value.inputHash)) || (value.outputHash !== undefined && !isDigest(value.outputHash))
    || (value.durationMs !== undefined && (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0))) return undefined;
  return value as ToolExecutionFact;
}

export function decodeToolOpportunityReport(value: unknown): ToolOpportunityReport | undefined {
  if (!recordOf(value) || !isJsonValue(value) || !keysAre(value, ["kind", "need", "reason", "toolCallIds", "existingCapability"], ["tool", "expectedBenefit"])
    || value.kind !== "opportunity" || !textOf(value.need, 2048) || !textOf(value.reason, 2048)
    || !stringIds(value.toolCallIds, 16) || (value.tool !== undefined && !textOf(value.tool, 256))
    || (value.expectedBenefit !== undefined && !textOf(value.expectedBenefit, 1024))
    || !["insufficient", "configuration_sufficient", "unknown"].includes(String(value.existingCapability))) return undefined;
  return value as ToolOpportunityReport;
}

export function decodeToolOpportunityEvidence(value: unknown): ToolOpportunityEvidence | undefined {
  if (!recordOf(value) || !isJsonValue(value) || !keysAre(value, ["reportId", "source", "assessment", "executions"], ["grounding", "catalog", "task"])
    || !textOf(value.reportId, 160) || !isOpportunitySource(value.source)) return undefined;

  const assessment = decodeToolOpportunityReport(value.assessment);
  if (assessment === undefined || !Array.isArray(value.executions) || value.executions.length > 16) return undefined;

  const executions = value.executions.map(decodeToolExecutionFact);
  if (executions.some(item => item === undefined)) return undefined;

  const facts = executions.filter((item): item is ToolExecutionFact => item !== undefined);
  const grounding = value.grounding === undefined ? undefined : decodeToolOpportunityGrounding(value.grounding);
  if (value.grounding !== undefined && grounding === undefined) return undefined;

  const catalog = value.catalog === undefined ? undefined : Array.isArray(value.catalog) && value.catalog.length <= 24
    ? value.catalog.map(decodeToolObservedCapability) : undefined;
  if (value.catalog !== undefined && (catalog === undefined || catalog.some(item => item === undefined))) return undefined;

  if (value.source === "model" && (assessment.toolCallIds.length === 0 ? catalog === undefined || facts.length !== 0
    : !assessment.toolCallIds.every(id => facts.some(fact => fact.toolCallId === id)))) return undefined;

  if (assessment.tool !== undefined && (facts.length > 0 ? !facts.some(fact => fact.tool === assessment.tool)
    : value.source === "model" && !catalog?.some(row => row?.tool === assessment.tool))) return undefined;

  const task = value.task === undefined ? undefined : decodeToolTaskText(value.task);
  if (value.task !== undefined && task === undefined) return undefined;

  return { reportId: value.reportId, source: value.source, assessment, executions: facts,
    ...(catalog === undefined ? {} : { catalog: catalog.filter((row): row is ToolObservedCapability => row !== undefined) }),
    ...(task === undefined ? {} : { task }),
    ...(grounding === undefined ? {} : { grounding }) };
}

export function decodeToolOpportunityGrounding(value: unknown): ToolOpportunityGrounding | undefined {
  if (!recordOf(value) || !isJsonValue(value) || !keysAre(value, ["source", "reference", "samples"])
    || (value.source !== "user_contract" && value.source !== "tool_contract" && value.source !== "observed_io")
    || !textOf(value.reference, 512) || !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 32
    || jsonBytes(value) > 131_072) return undefined;

  const samples: ToolEvolutionSample[] = [];

  for (const raw of value.samples) {
    const parsed = parseToolEvolutionSample(raw);
    if (!parsed.ok) return undefined;
    samples.push(parsed.value);
  }

  if (new Set(samples.map(item => item.sampleId)).size !== samples.length) return undefined;

  return { source: value.source, reference: value.reference, samples };
}

export function isOpportunitySource(value: unknown): value is ToolOpportunitySource {
  return value === "model" || value === "user" || value === "personal_agent" || value === "collaboration";
}

function stringIds(value: unknown, max: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= max && value.every(item => textOf(item, 256)) && new Set(value).size === value.length;
}
