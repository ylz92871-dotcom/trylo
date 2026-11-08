import { isMethodApplicationReport, sameApplicationReport, type MethodApplicationReport } from "./application-report.js";

/** Derived views only: the shared Board remains the sole persisted writer. */
export type MethodObservation = {
  readonly observationId: string;
  readonly taskId: string;
  readonly opportunityId: string;
  readonly versionId: string;
  readonly scopeId: string;
  /** Sequence of the original use, immutable under later corrections. */
  readonly sequence: number;
  /** Actual bound opportunity delivery. The parent origin sequence controls
   * prospective eligibility; this order precommits the dependent-unit
   * representative before feedback or later opportunity names are known. */
  readonly opportunitySequence?: number;
  readonly revision: number;
  readonly adoption: "adopted" | "displayed" | "deviated";
  readonly outcome: "helped" | "unhelpful" | "unknown" | "external_failure";
  readonly source: "self_report" | "external";
  readonly features: Readonly<Record<string, string>>;
  /** Host-provided cluster identity for known dependent/replayed task origins. */
  readonly correlationId?: string;
  /** New bound rows use absence for the original hint. Unbound historical rows
   * remain unresolved source/legacy evidence; no execution id is invented. */
  readonly compilationId?: string;
  /** Host precommits the first actually adopted opportunity in an origin and
   * expression, including when that opportunity never reports an outcome.
   * Later adopted opportunities remain real uses, but not independent trials. */
  readonly clusterRepresentative?: boolean;
  /** A bounded account of practice and result, never an independent verifier verdict. */
  readonly application?: MethodApplicationReport;
};

export type MethodExecutionBasis =
  | { readonly kind: "source" }
  | { readonly kind: "compilation"; readonly compilationId: string };

export type EvidenceSelection = {
  readonly versionId: string;
  readonly scopeId?: string;
  readonly sinceSequence?: number;
  readonly source?: MethodObservation["source"];
  /** Default to source evidence so old consumers cannot silently pool a new policy. */
  readonly executionBasis?: MethodExecutionBasis;
};

export type EvidenceSummary = {
  readonly successes: number;
  readonly failures: number;
  readonly unknown: number;
  readonly externalFailures: number;
  readonly notAdopted: number;
  /** Optional in older internal fixtures; projections always report a count. */
  readonly dependent?: number;
  readonly observationIds: ReadonlyArray<string>;
  /** Known, adopted, independent-unit representatives in use-sequence order. */
  readonly observations: ReadonlyArray<MethodObservation>;
};

export const MAX_OBSERVATION_FEATURES = 24;
export const MAX_OBSERVATION_ID_CHARS = 160;
export const MAX_FEATURE_KEY_CHARS = 64;
export const MAX_FEATURE_VALUE_CHARS = 160;

export function isMethodFeatures(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_OBSERVATION_FEATURES && entries.every(([key, entry]) =>
    boundedText(key, MAX_FEATURE_KEY_CHARS) && boundedText(entry, MAX_FEATURE_VALUE_CHARS));
}

/** Shared persistence/provider boundaries reuse this canonical payload guard. */
export function isMethodObservation(value: unknown): value is MethodObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const item = value as Record<string, unknown>;

  return ["observationId", "taskId", "opportunityId", "versionId", "scopeId"].every(key => boundedText(item[key], MAX_OBSERVATION_ID_CHARS)) &&
    nonnegativeInteger(item["sequence"]) && nonnegativeInteger(item["revision"]) &&
    (item["opportunitySequence"] === undefined || (nonnegativeInteger(item["opportunitySequence"]) &&
      typeof item["opportunitySequence"] === "number" && typeof item["sequence"] === "number" &&
      item["opportunitySequence"] >= item["sequence"])) &&
    (item["adoption"] === "adopted" || item["adoption"] === "displayed" || item["adoption"] === "deviated") &&
    (item["outcome"] === "helped" || item["outcome"] === "unhelpful" || item["outcome"] === "unknown" || item["outcome"] === "external_failure") &&
    (item["source"] === "self_report" || item["source"] === "external") &&
    (item["correlationId"] === undefined || boundedText(item["correlationId"], MAX_OBSERVATION_ID_CHARS)) &&
    (item["compilationId"] === undefined || boundedText(item["compilationId"], 200)) &&
    (item["clusterRepresentative"] === undefined || typeof item["clusterRepresentative"] === "boolean") &&
    (item["application"] === undefined || isMethodApplicationReport(item["application"])) && isMethodFeatures(item["features"]);
}

/**
 * Revisions replace one opportunity; they never become a second trial. Conflicts
 * fail explicitly rather than silently accepting whichever event replayed last.
 */
export function canonicalObservations(input: ReadonlyArray<MethodObservation>): ReadonlyArray<MethodObservation> {
  const latest = new Map<string, MethodObservation>();

  for (const item of input) {
    if (!isMethodObservation(item)) throw new Error("invalid_observation");

    const key = JSON.stringify([item.versionId, item.taskId, item.opportunityId, item.source]);
    const previous = latest.get(key);
    if (previous !== undefined) {
      if (!sameIdentity(previous, item)) throw new Error("immutable_observation_identity");
      if (previous.revision === item.revision && !sameVerdict(previous, item)) {
        throw new Error("conflicting_revision");
      }
    }

    if (previous === undefined || item.revision > previous.revision ||
      (item.revision === previous.revision && item.observationId < previous.observationId)) latest.set(key, item);
  }

  return [...latest.values()].sort((a, b) => a.sequence - b.sequence ||
    (a.opportunitySequence ?? a.sequence) - (b.opportunitySequence ?? b.sequence) || a.observationId.localeCompare(b.observationId));
}

export function evidenceOf(input: ReadonlyArray<MethodObservation>, selection: EvidenceSelection): EvidenceSummary {
  const selected = canonicalObservations(input).filter(item => item.versionId === selection.versionId &&
    (selection.scopeId === undefined || item.scopeId === selection.scopeId) &&
    item.sequence > (selection.sinceSequence ?? -1) && item.source === (selection.source ?? "self_report") &&
    matchesExecutionBasis(item, selection.executionBasis ?? { kind: "source" }));
  const observations: MethodObservation[] = [];
  const correlations = new Set<string>();
  let unknown = 0;
  let externalFailures = 0;
  let notAdopted = 0;
  let dependent = 0;
  let successes = 0;
  let failures = 0;

  for (const item of selected) {
    // Bound observations precommit their first actual adoption. Preserve the
    // old order for historical unbound rows so their qualification hashes can
    // still replay; they cannot retroactively gain provenance.
    const notAdoptedHere = item.adoption !== "adopted";
    if (notAdoptedHere && (item.opportunitySequence !== undefined || item.clusterRepresentative !== undefined ||
      item.compilationId !== undefined)) {
        notAdopted += 1;
        continue;
      }

    // Missing feedback on the precommitted representative must not let a later
    // opportunity become a trial. Scope filtering cannot resurrect this use.
    if (item.clusterRepresentative === false) {
      dependent += 1;
      continue;
    }

    if (item.correlationId !== undefined) {
      if (correlations.has(item.correlationId)) continue;
      // Reserve the first opportunity even if its feedback is missing: choosing
      // a known success from the same origin would introduce selection bias.
      correlations.add(item.correlationId);
    }

    if (notAdoptedHere) {
      notAdopted += 1;
      continue;
    }

    if (item.outcome === "unknown") {
      unknown += 1;
      continue;
    }

    if (item.outcome === "external_failure") {
      externalFailures += 1;
      continue;
    }

    observations.push(item);

    if (item.outcome === "helped") successes += 1;
    else failures += 1;
  }

  return { successes, failures, unknown, externalFailures, notAdopted, dependent,
    observationIds: observations.map(item => item.observationId), observations };
}

function sameIdentity(left: MethodObservation, right: MethodObservation): boolean {
  return left.source === right.source && left.sequence === right.sequence && left.opportunitySequence === right.opportunitySequence && left.scopeId === right.scopeId &&
    left.correlationId === right.correlationId && left.compilationId === right.compilationId &&
    left.clusterRepresentative === right.clusterRepresentative && JSON.stringify(sortedFeatures(left.features)) ===
    JSON.stringify(sortedFeatures(right.features));
}

function matchesExecutionBasis(observation: MethodObservation, basis: MethodExecutionBasis): boolean {
  return basis.kind === "source" ? observation.compilationId === undefined : observation.compilationId === basis.compilationId;
}

function sameVerdict(left: MethodObservation, right: MethodObservation): boolean {
  return left.adoption === right.adoption && left.outcome === right.outcome && left.source === right.source &&
    sameApplicationReport(left.application, right.application);
}

function sortedFeatures(features: Readonly<Record<string, string>>): ReadonlyArray<readonly [string, string]> {
  return Object.entries(features).sort(([a], [b]) => a.localeCompare(b));
}

function boundedText(value: unknown, cap: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= cap;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
