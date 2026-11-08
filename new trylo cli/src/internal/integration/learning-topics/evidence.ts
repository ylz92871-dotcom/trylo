import type { Envelope } from "../../protocol/envelope.js";
import type { TopicEvidenceWindow, TopicExperimentDescriptor } from "../../learning/domains/shared/topics/contracts.js";
import { TOPIC_EVIDENCE_ORIGINS } from "../../learning/domains/shared/topics/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { isTopicSemanticText } from "./semantic-text.js";
import { isTopicComparisonText } from "./comparison-evidence.js";

export { isTopicSemanticText } from "./semantic-text.js";

type Record = TopicEvidenceWindow["records"][number];

type ToolIdentity = { readonly name: string; readonly runId: string; readonly eventId: string };

export type TopicSemanticEvidenceProjector = (event: Envelope) => {
  readonly origin: Record["origin"]; readonly text: string;
} | undefined;

export type TopicEvidenceFailure = "topic_evidence_projection_failed" | "topic_evidence_projection_invalid"
  | "topic_evidence_identity_conflict" | "topic_evidence_capacity";

export class TopicEvidenceError extends Error {
  constructor(readonly reason: TopicEvidenceFailure) {
    super(reason);
    this.name = "TopicEvidenceError";
  }
}

const safeName = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const STATUSES = ["succeeded", "failed", "cancelled", "unknown"];

/** Default metadata stays unchanged; only a trusted host projector may supply bounded semantic text. */
export function createTopicEvidenceBuffer(owner: { readonly sessionId: string; readonly turnId: string; readonly scope: string;
  readonly experiments?: () => readonly TopicExperimentDescriptor[]; readonly projectEvidence?: TopicSemanticEvidenceProjector }) {
  const pending = new Map<string, ToolIdentity>(), records: Record[] = [];
  const byRef = new Map<string, { readonly coordinate: string; readonly hash: string }>();
  const byCoordinate = new Map<string, { readonly ref: string; readonly hash: string }>();
  const projector = owner.projectEvidence;
  let version = 0;

  function store(record: Record): void {
    const coordinate = canonicalJson([record.runId, record.sequence]), hash = contentHashOf(record);
    const ref = byRef.get(record.ref), position = byCoordinate.get(coordinate);
    if ((ref !== undefined && (ref.coordinate !== coordinate || ref.hash !== hash))
      || (position !== undefined && (position.ref !== record.ref || position.hash !== hash))) throw new TopicEvidenceError("topic_evidence_identity_conflict");

    if (ref !== undefined || position !== undefined) return;

    if (byRef.size >= 128) throw new TopicEvidenceError("topic_evidence_capacity");

    byRef.set(record.ref, { coordinate, hash });
    byCoordinate.set(coordinate, { ref: record.ref, hash });
    records.push(Object.freeze(record));
    if (records.length > 2) records.shift();
    version += 1;
  }

  return {
    get version() { return version; },

    capture(event: Envelope): void {
      if (event.sessionId !== owner.sessionId || event.turnId !== owner.turnId
        || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || !identity(event.eventId)) return;

      let projected: ReturnType<TopicSemanticEvidenceProjector>;

      try { projected = projector?.(event); }
      catch { throw new TopicEvidenceError("topic_evidence_projection_failed"); }

      if (projected !== undefined) {
        if (!fields(projected, ["origin", "text"]) || !TOPIC_EVIDENCE_ORIGINS.includes(projected.origin)
          || !isTopicSemanticText(projected.text)) throw new TopicEvidenceError("topic_evidence_projection_invalid");

        store({ ref: event.eventId, runId: `execution:${contentHashOf([owner.sessionId, owner.turnId, event.attemptId ?? null])}`,
          sequence: event.sequence, scope: owner.scope, origin: projected.origin, text: projected.text });

        if (event.kind === "tool_result" && event.attemptId && typeof event.payload.toolCallId === "string") {
          pending.delete(canonicalJson([event.attemptId, event.payload.toolCallId]));
        }

        return;
      }

      if (!event.attemptId) return;

      const callId = event.payload.toolCallId;
      if (typeof callId !== "string" || callId.length > 256) return;

      const key = canonicalJson([event.attemptId, callId]);

      if (event.kind === "tool_use" && safeName(event.payload.name)) {
        const previous = pending.get(key);
        if (previous !== undefined && (previous.eventId !== event.eventId || previous.name !== event.payload.name)) {
          throw new TopicEvidenceError("topic_evidence_identity_conflict");
        }

        if (!pending.has(key) && pending.size >= 32) throw new TopicEvidenceError("topic_evidence_capacity");

        pending.set(key, { name: event.payload.name, eventId: event.eventId,
          runId: `execution:${contentHashOf([owner.sessionId, owner.turnId, event.attemptId])}` });

        return;
      }

      if (event.kind !== "tool_result" || typeof event.payload.status !== "string" || !STATUSES.includes(event.payload.status)) return;

      const tool = pending.get(key);
      if (tool === undefined) return;

      pending.delete(key);
      const text = canonicalJson({ tool: tool.name, reportedStatus: event.payload.status });

      store({ ref: event.eventId, runId: tool.runId, sequence: event.sequence, scope: owner.scope, origin: "execution_result", text });
    },

    snapshot(boardSequence: number, catalog?: readonly TopicExperimentDescriptor[], comparison?: Record): string | undefined {
      if (records.length === 0) return undefined;

      let selected: readonly Record[] = records;

      if (comparison !== undefined) {
        if (comparison.scope !== owner.scope || comparison.sequence > boardSequence || comparison.origin !== "checker_result"
          || (!isTopicSemanticText(comparison.text) && !isTopicComparisonText(comparison.text))) throw new TopicEvidenceError("topic_evidence_projection_invalid");
        const repeated = records.find(record => record.ref === comparison.ref
          || (record.runId === comparison.runId && record.sequence === comparison.sequence));
        if (repeated !== undefined && canonicalJson(repeated) !== canonicalJson(comparison)) throw new TopicEvidenceError("topic_evidence_identity_conflict");
        selected = repeated === undefined ? [records.at(-1)!, comparison] : records;
      }

      const watermarks = new Map<string, number>();

      for (const record of selected) watermarks.set(record.runId, Math.max(watermarks.get(record.runId) ?? 0, record.sequence));

      // The shared-stream budget admits only a bounded host view, never a full-library scan.
      const experiments = (catalog ?? owner.experiments?.())?.slice(0, 2).map(entry => ({ ...entry }));

      return canonicalJson({ schemaVersion: 1, domain: "prompt", scope: owner.scope, boardSequence,
        watermarks: [...watermarks].map(([runId, throughSequence]) => ({ runId, throughSequence })), records: selected,
        ...(experiments === undefined || experiments.length === 0 ? {} : { experiments }) });
    },

    clear(): void {
      pending.clear();
      records.length = 0;
      byRef.clear();
      byCoordinate.clear();
    },
  };
}
