import { contentHashOf } from "../../../learning/control/hash.js";
import { isExecutionExtensionMetadata } from "../../../ports/execution-extension.js";
import { isTranscriptItem } from "../../../protocol/transcript.js";
import { parseEnvelope } from "../../../protocol/validate.js";
import type { SessionRecord } from "../../../ports/session.js";
import type { ContentArtifactMapping } from "./artifact.js";
import type { ContentAdoption, ContentAdoptionInput, ContentAdoptionProjection } from "./adoption-contract.js";
import { contentDeliveryReceiptId, isContentDeliveryConfiguration } from "./adoption-receipt.js";
import { isAdvisoryUseReport } from "./advisory-contract.js";

function adoption(input: Omit<ContentAdoption, "ref">): ContentAdoption {
  // Late feedback and a newer Board read may change the attached view, never the original adoption identity.
  return { ref: `content-adoption:${contentHashOf([input.basis, input.receiptId, input.artifact.ref, input.artifact.version,
    input.sessionId, input.turnId ?? null, input.attemptId ?? null])}`, ...input };
}

function versionMatches(artifact: ContentArtifactMapping, versionId: string): boolean {
  return artifact.version === versionId || artifact.ref === versionId;
}

function argumentsFor(records: readonly SessionRecord[], turnId: string, callId: string) {
  return records.filter(item => item.turnId === turnId && item.type === "transcript_item"
    && isTranscriptItem(item.payload) && item.payload.kind === "tool_call" && item.payload.toolCallId === callId)
    .map(item => item.payload).filter(isTranscriptItem).filter(item => item.kind === "tool_call");
}

/** Existing receipts only. Same-scope assets, a successful task or a model mention cannot create an adoption. */
export function projectContentAdoptions(input: ContentAdoptionInput): ContentAdoptionProjection {
  const adoptions: ContentAdoption[] = [], gaps: ContentAdoptionProjection["gaps"][number][] = [];
  const deliveries = new Set<string>();
  const requestRows = new Map<string, SessionRecord[]>();

  for (const row of input.records) {
    if (row.type !== "envelope") continue;
    const parsed = parseEnvelope(row.payload.envelope);
    if (!parsed.ok || parsed.envelope.sessionId !== input.sessionId || parsed.envelope.producerId !== "loop"
      || parsed.envelope.turnId === undefined || parsed.envelope.attemptId === undefined) continue;
    const key = JSON.stringify([parsed.envelope.turnId, parsed.envelope.attemptId]), group = requestRows.get(key) ?? [];
    group.push(row);
    requestRows.set(key, group);
  }

  const bindings = new Map(input.bindings.map(binding => [binding.exposureId, binding]));

  for (const exposure of input.board.rewardExposures ?? []) {
    const binding = bindings.get(exposure.id);
    if (!binding || exposure.source.sessionId !== input.sessionId || exposure.source.turnId !== binding.source.turnId
      || exposure.source.attemptId !== binding.source.attemptId || exposure.source.eventId !== binding.source.eventId) continue;

    for (const artifact of input.artifacts) {
      if (!exposure.targets.some(target => target.id === artifact.ref && target.version === artifact.version)) continue;
      adoptions.push(adoption({ artifact, basis: "reward_target", exposure: "requested", receiptId: exposure.id,
        sessionId: input.sessionId, turnId: binding.source.turnId, attemptId: binding.source.attemptId,
        toolUnitId: binding.unit.unitId, sourceSequence: binding.unit.registeredAt,
        sourceRefs: [...artifact.sourceRefs, exposure.id, binding.source.eventId],
        details: JSON.stringify({ exposure, interpretation: "registered_tool_request_not_proof_permission_granted_or_execution" }) }));
    }
  }

  for (const fielding of input.board.fieldings) {
    const artifacts = input.artifacts.filter(artifact => artifact.subsystem === "method" && versionMatches(artifact, fielding.versionId));
    if (artifacts.length === 0) continue;

    const requests = requestRows.get(JSON.stringify([fielding.turnId, fielding.requestId])) ?? [];
    if (requests.length === 0) {
      gaps.push({ receiptId: fielding.exposureId, reason: "session_address_missing", sourceRefs: [fielding.exposureId, fielding.versionId] });
      continue;
    }

    const feedback = input.board.feedbacks.filter(item => item.exposureId === fielding.exposureId && item.versionId === fielding.versionId);

    for (const artifact of artifacts) adoptions.push(adoption({ artifact, basis: "method_fielding", exposure: "displayed",
      receiptId: fielding.exposureId, sessionId: input.sessionId, turnId: fielding.turnId, attemptId: fielding.requestId,
      ...(fielding.useSequence === undefined ? {} : { boardUseSequence: fielding.useSequence }),
      sourceSequence: requests[0]!.sequence, sourceRefs: [...artifact.sourceRefs, fielding.exposureId, fielding.proposalId],
      details: JSON.stringify({ fielding, feedback, interpretation: "provider_received_context_not_proof_method_followed_or_helped" }) }));
  }

  for (const use of input.board.toolUses ?? []) {
    if (use.sessionId !== input.sessionId) continue;

    const artifacts = input.artifacts.filter(artifact => artifact.subsystem === "tool" && versionMatches(artifact, use.versionId));
    if (artifacts.length === 0) continue;

    let candidates = input.bindings.filter(binding => binding.toolCallId === use.toolCallId);
    if (candidates.length > 1) candidates = candidates.filter(binding => argumentsFor(input.records, binding.source.turnId, use.toolCallId)
      .some(call => "input" in call.arguments && contentHashOf(call.arguments.input) === use.inputHash));

    if (candidates.length !== 1) {
      gaps.push({ receiptId: use.useId, reason: "ambiguous_tool_address", sourceRefs: [use.useId, use.versionId] });
      continue;
    }

    const binding = candidates[0]!;

    for (const artifact of artifacts) adoptions.push(adoption({ artifact, basis: "tool_use",
      exposure: use.execution === "unavailable" || use.execution === "cancelled" ? "adopted" : "executed",
      receiptId: use.useId, sessionId: use.sessionId, turnId: binding.source.turnId, attemptId: binding.source.attemptId,
      toolUnitId: binding.unit.unitId, sourceSequence: binding.unit.registeredAt,
      sourceRefs: [...artifact.sourceRefs, use.useId, ...(use.usageLessonRefs ?? []), binding.source.eventId],
      details: JSON.stringify({ use, interpretation: "canonical_tool_execution_quality_remains_unverified" }) }));
  }

  for (const item of input.records) {
    if (item.type !== "execution_extension") continue;

    if (!isExecutionExtensionMetadata(item.payload)) {
      gaps.push({ receiptId: `${input.sessionId}:${item.sequence}`, reason: "workflow_metadata_invalid", sourceRefs: [] });
      continue;
    }

    const metadata = item.payload, configuration = metadata.configuration;
    if (metadata.owner === "workflow" && configuration.schemaVersion === 1 && configuration.kind === "adoption"
      && typeof configuration.versionId === "string") {
      for (const artifact of input.artifacts.filter(row => row.subsystem === "workflow" && versionMatches(row, String(configuration.versionId)))) {
        adoptions.push(adoption({ artifact, basis: "workflow_session_adoption", exposure: "adopted", receiptId: metadata.instanceId,
          sessionId: input.sessionId, ...(item.turnId === undefined ? {} : { turnId: item.turnId }), sourceSequence: item.sequence,
          sourceRefs: [...artifact.sourceRefs, `session:${input.sessionId}:${item.sequence}`],
          details: JSON.stringify({ metadata, interpretation: "adopted_workflow_version_not_completion_or_learning_gain" }) }));
      }
    }

    if (metadata.owner === "learning-content") {
      // Advisory declarations have their original publication/purpose owner.
      // They are projected separately, never forged into an asset adoption.
      if (isAdvisoryUseReport(configuration)) continue;

      if (!isContentDeliveryConfiguration(configuration) || metadata.instanceId !== contentDeliveryReceiptId(input.sessionId, configuration)
        || item.turnId !== undefined && item.turnId !== configuration.turnId) {
        gaps.push({ receiptId: metadata.instanceId, reason: "content_delivery_metadata_invalid", sourceRefs: [`session:${input.sessionId}:${item.sequence}`] });
        continue;
      }

      if (deliveries.has(metadata.instanceId)) continue;

      deliveries.add(metadata.instanceId);
      const deliveredRefs = configuration.refs;
      const artifactRefs = configuration.artifactRefs ?? [];

      for (const artifact of input.artifacts.filter(row => deliveredRefs.some(ref => ref.contentFactId === row.ref && ref.processId === row.version)
        || artifactRefs.some(ref => ref.ref === row.ref && ref.version === row.version))) {
        adoptions.push(adoption({ artifact, basis: "content_context_delivery", exposure: "displayed", receiptId: metadata.instanceId,
          sessionId: input.sessionId, turnId: configuration.turnId, attemptId: configuration.attemptId, sourceSequence: item.sequence,
          sourceRefs: [...artifact.sourceRefs, `session:${input.sessionId}:${item.sequence}`],
          details: JSON.stringify({ metadata, interpretation: "content_delivered_to_execution_context_not_proof_of_benefit" }) }));
      }
    }
  }

  return { adoptions, gaps };
}
