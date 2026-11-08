import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "./parse.js";

export type ToolDiscoverySummary = {
  readonly status: "complete" | "partial" | "failed";
  readonly candidates: readonly { readonly platform: string; readonly id: string; readonly sourceUrl: string; readonly licenseSpdx: string; readonly version?: string }[];
  readonly failures: readonly { readonly platform: string; readonly stage: string; readonly code: string }[];
};

export function decodeDiscoverySummary(raw: unknown): ToolDiscoverySummary | undefined {
  if (!recordOf(raw)) return undefined;

  const value = raw;
  if (!isJsonValue(raw) || jsonBytes(raw) > 65_536 || !keysAre(value, ["status", "candidates", "failures"])
    || !["complete", "partial", "failed"].includes(String(value.status)) || !Array.isArray(value.candidates) || value.candidates.length > 20
    || !Array.isArray(value.failures) || value.failures.length > 84) return undefined;

  for (const rawCandidate of value.candidates) {
    if (!recordOf(rawCandidate)) return undefined;
    const candidate = rawCandidate;
    if (!keysAre(candidate, ["platform", "id", "sourceUrl", "licenseSpdx"], ["version"])
      || !bounded(candidate.platform, 32) || !bounded(candidate.id, 512) || !bounded(candidate.sourceUrl, 2_048)
      || !bounded(candidate.licenseSpdx, 128) || (candidate.version !== undefined && !bounded(candidate.version, 256))) return undefined;
  }

  for (const rawFailure of value.failures) {
    if (!recordOf(rawFailure)) return undefined;
    const failure = rawFailure;
    if (!keysAre(failure, ["platform", "stage", "code"]) || !bounded(failure.platform, 32)
      || !bounded(failure.stage, 32) || !bounded(failure.code, 160)) return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as ToolDiscoverySummary;
}

function bounded(value: unknown, length: number): value is string { return textOf(value, length); }
