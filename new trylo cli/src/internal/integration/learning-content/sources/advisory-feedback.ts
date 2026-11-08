import type { BoardState } from "../../../learning/control/state.js";
import type { SessionRecord } from "../../../ports/session.js";
import type { OrganizationFeedback } from "../../../learning/central/organization/contracts.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { redactText } from "../../../credentials/redact.js";
import { redactJsonValue } from "../../../protocol/redact.js";
import { readCentralAdvisory } from "../../central-learning/central-advisory-records.js";
import type { CentralAdvisoryPublicationView } from "../../central-learning/central-advisory-contracts.js";
import { readOrganizationRecords } from "../../../learning/central/organization/records.js";
import { centralOrganizationDeliberationRef, organizationDecisionForOperation } from "../../central-learning/organization-feedback-runtime.js";
import { contentDeliveryReceiptId, isContentDeliveryConfiguration } from "./adoption-receipt.js";
import { isAdvisoryUseReport, isContentAdvisoryIdentity, isContentAdvisoryRefs,
  type AdvisoryUseReport, type ContentAdvisoryRef } from "./advisory-contract.js";
import { advisoryUseReportId, findAdvisoryContextDelivery } from "./advisory-receipt.js";
import { advisoryReportBoundary, findAdvisoryReadEvidence } from "./advisory-read-evidence.js";
import { sessionContentRecordRef, sessionContentRecordView, sessionRecordOrigin, validateSessionContentJournal } from "./session-decode.js";

type Feedback = Omit<OrganizationFeedback, "supersedes">;

type Input = { readonly board: BoardState; readonly scope: string; readonly sessionId: string;
  readonly records: readonly SessionRecord[]; readonly secrets?: readonly string[] };

type Report = { readonly ref: string; readonly sequence: number; readonly value: AdvisoryUseReport };

type Unit = { readonly publication: CentralAdvisoryPublicationView; readonly turnId: string; readonly firstSequence: number;
  readonly deliveryRef: string; readonly sourceRefs: readonly string[]; readonly reports: readonly Report[] };

const unique = (values: readonly string[]) => [...new Set(values)];

function reportEvidence(input: Input, record: SessionRecord, report: AdvisoryUseReport): readonly string[] | undefined {
  const prefix = input.records.filter(row => row.sequence < record.sequence);
  const boundary = advisoryReportBoundary(prefix, { sessionId: input.sessionId, turnId: report.turnId, toolCallId: report.toolCallId });
  if (boundary === undefined) return undefined;

  const context = findAdvisoryContextDelivery(prefix, { sessionId: input.sessionId, turnId: report.turnId,
    advisory: report.advisory, beforeSequence: boundary, deliveryRef: report.deliveryRef });
  if (context !== undefined) return [sessionContentRecordRef(input.sessionId, context.sequence)];

  const read = findAdvisoryReadEvidence(prefix, { sessionId: input.sessionId, turnId: report.turnId,
    advisory: report.advisory, reportToolCallId: report.toolCallId });

  return read?.deliveryRef === report.deliveryRef ? read.sourceRefs : undefined;
}

/** Preserve an original source ref when an inline public excerpt must be smaller
 * than the organization summary envelope. No omitted text becomes new evidence. */
function excerpt(text: string, maximum: number, secrets: readonly string[]) {
  const scrubbed = redactJsonValue(redactText(text, secrets));
  if (typeof scrubbed !== "string") throw new Error("advisory_feedback_public_text_invalid");
  let end = Math.min(maximum, scrubbed.length);
  if (end > 0 && end < scrubbed.length && scrubbed.charCodeAt(end) >= 0xdc00 && scrubbed.charCodeAt(end) <= 0xdfff) end--;
  return { text: scrubbed.slice(0, end), omittedChars: scrubbed.length - end, complete: end === scrubbed.length };
}

function outcome(input: Input, unit: Unit) {
  const publicSources = input.records.filter(record => record.sequence > unit.firstSequence).flatMap(record => {
    const user = sessionRecordOrigin(record) === "user_statement";
    if (!user && !(record.type === "terminal" && record.turnId === unit.turnId)) return [];
    // This is the original shared public/private-producer and source-redaction boundary.
    const view = sessionContentRecordView(record, input.scope, input.secrets);
    return view === undefined ? [] : [{ record, view, user }];
  });
  const users = publicSources.filter(row => row.user), shownUsers = users.slice(-4);
  const terminals = publicSources.filter(row => !row.user), terminal = terminals.at(-1), report = unit.reports.at(-1);
  if (report === undefined && terminal === undefined && users.length === 0) return undefined;

  const through = Math.max(unit.firstSequence, report?.sequence ?? -1, ...publicSources.map(row => row.record.sequence));
  const directory = { sessionRef: input.sessionId, through,
    interpretation: "original_session_directory_not_new_evidence" };
  const makeSummary = (maximum: number) => canonicalJson({ schemaVersion: 1,
    role: "advisory_declaration_and_later_original_sources_not_learning_gain",
    paDeclaration: report === undefined ? null : { ref: report.ref, declarationCount: unit.reports.length,
      change: excerpt(report.value.change, maximum, input.secrets ?? []), reason: excerpt(report.value.reason, maximum, input.secrets ?? []),
      interpretation: "explicit_pa_self_report_not_verified_following_or_effectiveness" },
    taskLifecycle: { ref: terminal?.view.record.ref ?? null, available: terminals.length, shown: terminal === undefined ? 0 : 1,
      omitted: Math.max(0, terminals.length - 1), publicReport: terminal === undefined ? null : excerpt(terminal.view.record.text, maximum, input.secrets ?? []),
      interpretation: "actual_task_lifecycle_and_usage_not_advisory_credit" },
    laterUser: { role: "unassigned_original_user_sources_not_corrections", sourceRefs: shownUsers.map(row => row.view.record.ref),
      available: users.length, shown: shownUsers.length, omitted: users.length - shownUsers.length, directory, targetKnown: false },
    interpretation: "exposure_or_declared_use_and_task_success_do_not_establish_learning_gain" });
  const summary = makeSummary(384);
  const bounded = summary.length <= 4096 ? summary : makeSummary(0);
  if (bounded.length > 4096) throw new Error("advisory_feedback_summary_capacity");

  return { summary: bounded, refs: [...(terminal === undefined ? [] : [terminal.view.record.ref]), ...shownUsers.map(row => row.view.record.ref)] };
}

/** Derive one stable task/publication unit from original receipts only. Board
 * writes, supersession and missing decision handling remain with the original organization owner. */
export function projectAdvisorySessionFeedbackWithSources(input: Input): { readonly feedback: readonly Feedback[];
  readonly sourceUnits: readonly { readonly unitRef: string; readonly publicationRef: string; readonly intentId: string }[] } {
  if (!isContentAdvisoryIdentity(input.sessionId) || !validateSessionContentJournal({ records: input.records, tornTail: false }, input.sessionId).ok) {
    throw new Error("advisory_feedback_journal_invalid");
  }

  const units = new Map<string, Unit>(), delivered = new Set<string>(), reports = new Map<string, string>();
  const merge = (advisory: ContentAdvisoryRef, turnId: string, sequence: number, deliveryRef: string,
    sourceRefs: readonly string[], report?: Report) => {
    const publication = readCentralAdvisory(input.board, input.scope, advisory);
    if (publication === undefined) return;
    const key = canonicalJson([turnId, publication.version]), previous = units.get(key);
    units.set(key, { publication, turnId, firstSequence: Math.min(previous?.firstSequence ?? sequence, sequence),
      deliveryRef: previous?.deliveryRef ?? deliveryRef, sourceRefs: unique([...(previous?.sourceRefs ?? []), deliveryRef, ...sourceRefs]),
      reports: report === undefined ? previous?.reports ?? [] : [...(previous?.reports ?? []), report] });
  };

  for (const record of input.records) {
    if (record.type !== "execution_extension") continue;

    const metadata = record.payload;
    if (metadata.schemaVersion !== 1 || metadata.owner !== "learning-content" || !isContentAdvisoryIdentity(record.turnId)
      || !isContentAdvisoryIdentity(metadata.instanceId)) continue;

    const configuration = metadata.configuration;
    if (isContentDeliveryConfiguration(configuration) && configuration.turnId === record.turnId
      && "advisoryRefs" in configuration && isContentAdvisoryRefs(configuration.advisoryRefs)
      && metadata.instanceId === contentDeliveryReceiptId(input.sessionId, configuration)) {
      if (delivered.has(metadata.instanceId)) continue;
      delivered.add(metadata.instanceId);
      for (const advisory of configuration.advisoryRefs) merge(advisory, record.turnId, record.sequence, metadata.instanceId,
        [sessionContentRecordRef(input.sessionId, record.sequence)]);
      continue;
    }

    if (!isAdvisoryUseReport(configuration) || configuration.turnId !== record.turnId
      || metadata.instanceId !== advisoryUseReportId(input.sessionId, configuration.turnId, configuration.toolCallId)) continue;

    const serialized = canonicalJson(configuration), previous = reports.get(metadata.instanceId);
    if (previous !== undefined && previous !== serialized) throw new Error("advisory_feedback_report_conflict");

    if (previous !== undefined) continue;

    const evidence = reportEvidence(input, record, configuration);
    if (evidence === undefined) continue;

    reports.set(metadata.instanceId, serialized);
    const ref = sessionContentRecordRef(input.sessionId, record.sequence);

    merge(configuration.advisory, record.turnId, record.sequence, configuration.deliveryRef, [ref, ...evidence],
      { ref, sequence: record.sequence, value: configuration });
  }

  const result: Feedback[] = [], sourceUnits: { unitRef: string; publicationRef: string; intentId: string }[] = [];
  const organization = readOrganizationRecords(input.board.rewardV2Facts ?? [], input.scope, input.board.sequence);

  for (const unit of units.values()) {
    const publication = unit.publication, report = unit.reports.at(-1);
    const unitRef = `advisory-session-use:${contentHashOf([input.sessionId, unit.turnId, publication.version])}`;
    const exposureRef = report?.value.deliveryRef ?? unit.deliveryRef;
    // Prioritize immutable authority/use identities. The actual session remains the directory for omitted references.
    const refs = unique([publication.id, publication.version, publication.intentId, exposureRef, ...unit.reports.slice(-1).map(row => row.ref),
      input.sessionId, ...unit.sourceRefs, ...publication.sourceRefs]);
    const computation = organization.decisions.find(row => row.value.decisionRef === centralOrganizationDeliberationRef(input.scope, publication.decisionRef)
      && organizationDecisionForOperation(input.scope, row.value, publication.decisionRef))
      ?? organization.decisions.find(row => row.value.decisionRef === publication.decisionRef
        && row.value.purposeRef === publication.decisionRef && organizationDecisionForOperation(input.scope, row.value, publication.decisionRef));
    if (computation === undefined) throw new Error("advisory_original_decision_unavailable");

    sourceUnits.push({ unitRef, publicationRef: publication.version, intentId: publication.intentId });
    const common = { kind: "feedback" as const, decisionRef: computation.value.decisionRef, unitRef };

    result.push({ ...common, sourceRefs: refs.slice(0, 64), result: { kind: "adoption", state: report === undefined ? "not_observed" : "used",
      artifactRefs: [publication.id, publication.version], exposureRef } });
    const later = outcome(input, unit);
    if (later !== undefined) result.push({ ...common, sourceRefs: unique([publication.id, publication.version, publication.intentId,
      exposureRef, ...unit.reports.slice(-1).map(row => row.ref), input.sessionId, ...later.refs, ...unit.sourceRefs]).slice(0, 64),
    result: { kind: "outcome", state: "unknown", attribution: "unknown", exposureRef, summary: later.summary } });
  }

  return { feedback: result, sourceUnits };
}

export function projectAdvisorySessionFeedback(input: Input): readonly Feedback[] {
  return projectAdvisorySessionFeedbackWithSources(input).feedback;
}
