import type { SessionPort } from "../../../ports/session.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { isContentAdvisoryRefs, type ContentAdvisoryRef } from "./advisory-contract.js";

export interface ContentDeliveryRef {
  readonly contentFactId: string;
  readonly processId: string;
  readonly questionRefs: readonly string[];
  readonly answerRefs: readonly string[];
}

export interface ContentDeliveryArtifactRef { readonly ref: string; readonly version: string }

export interface ContentDeliveryConfiguration {
  readonly schemaVersion: 1;
  readonly kind: "context_delivered";
  readonly turnId: string;
  readonly attemptId: string;
  readonly refs: readonly ContentDeliveryRef[];
  readonly artifactRefs?: readonly ContentDeliveryArtifactRef[];
  readonly advisoryRefs?: readonly ContentAdvisoryRef[];
  readonly materialHash: string;
}

export interface ContentContextDelivery {
  readonly session: Pick<SessionPort, "append">;
  readonly sessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly refs: readonly ContentDeliveryRef[];
  readonly artifactRefs?: readonly ContentDeliveryArtifactRef[];
  readonly advisoryRefs?: readonly ContentAdvisoryRef[];
  readonly materialHash: string;
  readonly now: () => number;
}

export type ContentDeliveryResult = { readonly status: "recorded"; readonly receiptId: string; readonly sequence: number }
  | { readonly status: "rejected" | "unconfirmed"; readonly reason: string };

function identity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }

export function isContentDeliveryRef(value: unknown): value is ContentDeliveryRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return identity(row.contentFactId) && identity(row.processId) && Array.isArray(row.questionRefs) && row.questionRefs.length <= 32
    && row.questionRefs.every(identity) && Array.isArray(row.answerRefs) && row.answerRefs.length <= 32 && row.answerRefs.every(identity);
}

export function isContentDeliveryArtifactRef(value: unknown): value is ContentDeliveryArtifactRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return identity(row.ref) && identity(row.version);
}

export function isContentDeliveryConfiguration(value: unknown): value is ContentDeliveryConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const row = value as Record<string, unknown>;

  return row.schemaVersion === 1 && row.kind === "context_delivered" && identity(row.turnId) && identity(row.attemptId)
    && typeof row.materialHash === "string" && /^[a-f0-9]{64}$/.test(row.materialHash)
    && Array.isArray(row.refs) && row.refs.length <= 32 && row.refs.every(isContentDeliveryRef)
    && (row.artifactRefs === undefined || Array.isArray(row.artifactRefs) && row.artifactRefs.length <= 32 && row.artifactRefs.every(isContentDeliveryArtifactRef))
    && (row.advisoryRefs === undefined || isContentAdvisoryRefs(row.advisoryRefs))
    && row.refs.length + (Array.isArray(row.artifactRefs) ? row.artifactRefs.length : 0) + (Array.isArray(row.advisoryRefs) ? row.advisoryRefs.length : 0) > 0;
}

export function contentDeliveryReceiptId(sessionId: string, configuration: ContentDeliveryConfiguration): string {
  return `content-delivery:${contentHashOf([sessionId, configuration])}`;
}

/** Call once, only after the provider's real stream_start for this exact frozen context.
 * The SessionPort remains the sole writer. An uncertain append is never retried here or called successful.
 */
export async function recordContentContextDelivery(input: ContentContextDelivery): Promise<ContentDeliveryResult> {
  if (![input.sessionId, input.turnId, input.attemptId].every(identity) || !/^[a-f0-9]{64}$/.test(input.materialHash)
    || !Array.isArray(input.refs) || input.refs.length > 32 || !input.refs.every(isContentDeliveryRef)
    || (input.artifactRefs !== undefined && (!Array.isArray(input.artifactRefs) || input.artifactRefs.length > 32
      || !input.artifactRefs.every(isContentDeliveryArtifactRef)))
    || input.advisoryRefs !== undefined && !isContentAdvisoryRefs(input.advisoryRefs)
    || input.refs.length + (input.artifactRefs?.length ?? 0) + (input.advisoryRefs?.length ?? 0) === 0) {
    return { status: "rejected", reason: "content_delivery_invalid" };
  }

  let now: number;

  try { now = input.now(); }
  catch { return { status: "rejected", reason: "content_delivery_time_unavailable" }; }

  if (!Number.isFinite(now) || Math.abs(now) > 8_640_000_000_000_000) return { status: "rejected", reason: "content_delivery_time_invalid" };

  const configuration = { schemaVersion: 1 as const, kind: "context_delivered" as const, turnId: input.turnId, attemptId: input.attemptId,
    refs: input.refs.map(ref => ({ ...ref, questionRefs: [...ref.questionRefs], answerRefs: [...ref.answerRefs] })),
    ...(input.advisoryRefs === undefined ? {} : { advisoryRefs: input.advisoryRefs.map(ref => ({ ...ref })) }),
    ...(input.artifactRefs === undefined ? {} : { artifactRefs: input.artifactRefs.map(ref => ({ ...ref })) }), materialHash: input.materialHash };
  const receiptId = contentDeliveryReceiptId(input.sessionId, configuration);

  try {
    const written = await input.session.append({ type: "execution_extension", sessionId: input.sessionId, turnId: input.turnId,
      at: new Date(now).toISOString(), payload: { schemaVersion: 1, owner: "learning-content", instanceId: receiptId, configuration } });
    return written.ok ? { status: "recorded", receiptId, sequence: written.sequence }
      : { status: "unconfirmed", reason: written.code };
  } catch { return { status: "unconfirmed", reason: "content_delivery_append_unconfirmed" }; }
}
