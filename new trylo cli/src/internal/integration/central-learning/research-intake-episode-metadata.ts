import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { LearningIssueReport } from "../../learning/control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, text } from "../../validation/json-shape.js";
import { CentralResearchIntakeError, type GroundedCentralResearch } from "./research-intake-common.js";

export interface CentralResearchEpisodePrevious { readonly issueId: string; readonly grantId: string | null; readonly requestRef: string; readonly programRef: string | null }

export type CentralResearchEpisodeSelection = "initial" | "reuse_open" | "reuse_program" | "derived_continuation" | "legacy_program_unrecorded";

export interface CentralResearchEpisodeMetadata {
  readonly schemaVersion: 1; readonly role: "derived_central_research_episode_not_new_business_evidence";
  readonly scope: string; readonly domain: GroundedCentralResearch["domain"]; readonly intentRef: string;
  readonly baseRequestRef: string; readonly requestRef: string; readonly programRef: string;
  readonly selection: CentralResearchEpisodeSelection; readonly previous: CentralResearchEpisodePrevious | null;
  readonly interpretation: "derived_continuation_of_original_intent_not_new_business_observation_or_value_estimate";
}

export const CENTRAL_RESEARCH_PROGRAM = /^central-research-program:[a-f0-9]{64}$/;
export const CENTRAL_RESEARCH_EPISODE_META = "central-research-episode-metadata:";
export const CENTRAL_RESEARCH_PROGRAM_REPORT = "central-research-program-report:";
const fail = (reason: string, refs: readonly string[]): never => { throw new CentralResearchIntakeError(reason, refs); };

function isMetadata(body: unknown): body is CentralResearchEpisodeMetadata {
  return fields(body, ["schemaVersion", "role", "scope", "domain", "intentRef", "baseRequestRef", "requestRef", "programRef", "selection", "previous", "interpretation"])
    && body.schemaVersion === 1 && body.role === "derived_central_research_episode_not_new_business_evidence"
    && [body.scope, body.intentRef, body.baseRequestRef, body.requestRef, body.programRef].every(value => text(value, 512))
    && typeof body.domain === "string" && ["prompt", "tool", "workflow", "skill", "collaboration"].includes(body.domain)
    && typeof body.programRef === "string" && CENTRAL_RESEARCH_PROGRAM.test(body.programRef)
    && ["initial", "reuse_open", "reuse_program", "derived_continuation", "legacy_program_unrecorded"].includes(String(body.selection))
    && body.interpretation === "derived_continuation_of_original_intent_not_new_business_observation_or_value_estimate"
    && (body.previous === null || fields(body.previous, ["issueId", "grantId", "requestRef", "programRef"])
      && [body.previous.issueId, body.previous.requestRef].every(value => text(value, 512))
      && (body.previous.grantId === null || text(body.previous.grantId, 512))
      && (body.previous.programRef === null || typeof body.previous.programRef === "string" && CENTRAL_RESEARCH_PROGRAM.test(body.previous.programRef)));
}

export function centralResearchEpisodeMetadataMaterial(value: CentralResearchEpisodeMetadata): CentralRuntimeMaterial {
  if (!isMetadata(value)) return fail("central_research_episode_metadata_invalid", []);
  const body = canonicalJson(value);
  return { ref: `${CENTRAL_RESEARCH_EPISODE_META}${contentHashOf(body)}`, kind: "source", text: body,
    sourceRefs: [...new Set([value.baseRequestRef, value.programRef,
      ...(value.previous === null ? [] : [value.previous.issueId, ...(value.previous.grantId === null ? [] : [value.previous.grantId])])])] };
}

export function readCentralResearchEpisodeMetadata(materials: readonly CentralRuntimeMaterial[]): CentralResearchEpisodeMetadata | undefined {
  const selected = materials.filter(row => row.ref.startsWith(CENTRAL_RESEARCH_EPISODE_META));
  if (selected.length > 1) return fail("central_research_episode_metadata_ambiguous", selected.map(row => row.ref));

  const material = selected[0];
  if (material === undefined) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); }
  catch { return fail("central_research_episode_metadata_invalid", [material.ref]); }

  if (!isMetadata(body) || canonicalJson(centralResearchEpisodeMetadataMaterial(body)) !== canonicalJson(material)) {
    return fail("central_research_episode_metadata_invalid", [material.ref]);
  }

  return body;
}

/** Pure original-report reader. Reception fixes navigation metadata, never proves
 * a committed stage, model invocation, finding, or independent business sample.
 */
export function readCentralResearchProgramReportMetadata(report: LearningIssueReport): CentralResearchEpisodeMetadata | undefined {
  if (!report.reportId.startsWith(CENTRAL_RESEARCH_PROGRAM_REPORT)) return undefined;

  const parts = report.facts.slice(1);
  if (report.facts[0] !== "central_research_program_reception_not_execution" || parts.length === 0
    || parts.some(part => !part.startsWith("episode_metadata_part:"))) return fail("central_research_program_metadata_invalid", [report.reportId]);

  let value: unknown;

  try { value = JSON.parse(parts.map(part => part.slice("episode_metadata_part:".length)).join("")); }
  catch { return fail("central_research_program_metadata_invalid", [report.reportId]); }

  if (!isMetadata(value) || !report.evidenceRefs.includes(centralResearchEpisodeMetadataMaterial(value).ref)
    || !report.evidenceRefs.includes(value.programRef) || !report.evidenceRefs.includes(value.intentRef)
    || !report.evidenceRefs.includes(value.requestRef)) return fail("central_research_program_metadata_invalid", [report.reportId]);

  if ("kind" in report.source && (report.source.domain !== value.domain || report.source.requestRef !== value.requestRef || report.source.intentRef !== value.intentRef)
    || "subsystem" in report.source && (report.source.subsystem === "method" ? "prompt" : report.source.subsystem) !== value.domain) {
    return fail("central_research_program_metadata_invalid", [report.reportId]);
  }

  return value;
}
