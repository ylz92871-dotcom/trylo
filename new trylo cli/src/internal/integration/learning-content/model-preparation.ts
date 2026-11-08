import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { readContentPacket } from "../../learning/central/content/material.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import type { ContentSemanticRequest, KnownApplicationDraft } from "../../learning/central/content/process-contract.js";
import { readKnownApplication, readResidualReview } from "../../learning/central/content/process-parse.js";
import type { ProviderMessage, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { fields, text } from "../../validation/json-shape.js";
import { ContentModelError, type ContentSemanticModelOptions } from "./model-contract.js";
import { contentModelResponseSchema } from "./model-schema.js";

interface ContentModelMaterial { readonly packet: ContentPacket; readonly applied?: KnownApplicationDraft }

export interface PreparedContentModelCall {
  readonly material: ContentModelMaterial;
  readonly provider: ProviderPort;
  readonly request: ProviderRequest;
  readonly reservationId: string;
  readonly maxTokens: number;
}

function suppliedMaterial(request: ContentSemanticRequest): ContentModelMaterial {
  if ((request.stage !== "apply_known" && request.stage !== "residual_review") || !text(request.instruction, 16384)
    || !text(request.materialJson, 262144) || request.inputHash !== contentHashOf({ stage: request.stage,
      instruction: request.instruction, materialJson: request.materialJson })) throw new ContentModelError("content_model_request_invalid");

  let value: unknown;

  try { value = JSON.parse(request.materialJson); }
  catch { throw new ContentModelError("content_model_request_invalid"); }

  if (!fields(value, request.stage === "apply_known" ? ["packet"] : ["packet", "applied"])) throw new ContentModelError("content_model_request_invalid");

  const packet = readContentPacket(value.packet);
  if (!packet.ok) throw new ContentModelError("content_model_packet_invalid");

  if (request.stage === "apply_known") return { packet: packet.value };

  const applied = readKnownApplication(canonicalJson(value.applied), packet.value);
  if (!applied.ok) throw new ContentModelError(applied.reason);

  return { packet: packet.value, applied: applied.value };
}

export function contentModelResponseFailure(output: string, material: ContentModelMaterial): string | undefined {
  const parsed = material.applied === undefined ? readKnownApplication(output, material.packet)
    : readResidualReview(output, material.packet, material.applied);
  return parsed.ok ? undefined : parsed.reason;
}

export function contentModelContext(options: ContentSemanticModelOptions): readonly ProviderMessage[] {
  const supplied = options.contextMessages ?? [];
  if (!Array.isArray(supplied) || supplied.length > 32 || !supplied.every(message => fields(message, ["role", "content"])
    && typeof message.role === "string" && ["system", "user", "assistant"].includes(message.role) && text(message.content, 65536))) {
    throw new ContentModelError("content_model_context_invalid");
  }
  return Object.freeze(supplied.map(message => Object.freeze({ ...message })));
}

/** Admission includes every message/schema byte and native overhead. These are caps,
 * not bills; the stream's actual final usage is settled by the model adapter. */
export async function prepareContentModelCall(options: ContentSemanticModelOptions, request: ContentSemanticRequest,
  limits: { readonly context: readonly ProviderMessage[]; readonly outputLimit: number }, signal: AbortSignal): Promise<PreparedContentModelCall> {
  const material = suppliedMaterial(request), current = await options.funding.inspect();
  if (!current.ok) throw new ContentModelError(current.reason);

  const grant = current.grant;
  if (!current.active || grant.grantId !== options.grantId || grant.jobId !== options.jobId || grant.claim?.claimId !== options.claimId
    || grant.scope !== material.packet.scope || (grant.domain ?? "collaboration") !== material.packet.domain
    || (material.packet.focus !== undefined && material.packet.focus.issueId !== grant.issueId)) {
    throw new ContentModelError("content_model_funding_mismatch");
  }

  const provider = options.provider.fork?.([]);
  if (provider === undefined || provider === options.provider) throw new ContentModelError("content_model_provider_isolation_unavailable");

  const reservationId = `content-model:${contentHashOf({ jobId: options.jobId, grantId: options.grantId, claimId: options.claimId,
    stage: request.stage, inputHash: request.inputHash, model: options.model, contextHash: contentHashOf(limits.context) })}`;
  const messages: readonly ProviderMessage[] = [...limits.context, { role: "system", content: request.instruction }, { role: "user", content: request.materialJson }];
  const responseSchema = contentModelResponseSchema(request.stage), prompt = canonicalJson({ messages, tools: [], responseSchema });
  if (prompt.length > grant.allowance.maxPromptChars) throw new ContentModelError("content_model_prompt_limit");

  const overhead = provider.continuation?.estimateOverheadTokens?.(messages) ?? 0;
  if (!Number.isSafeInteger(overhead) || overhead < 0) throw new ContentModelError("content_model_overhead_invalid");

  const inputReserve = new TextEncoder().encode(prompt).length + 512 + overhead;
  const maxOutputTokens = Math.min(limits.outputLimit, current.remaining.tokens - inputReserve), maxTokens = inputReserve + maxOutputTokens;
  if (maxOutputTokens < 256 || current.remaining.calls < 1 || current.remaining.steps < 1) throw new ContentModelError("content_model_budget_exhausted");

  if (signal.aborted || options.enabled?.() === false) throw new ContentModelError("content_model_cancelled");

  return { material, provider, reservationId, maxTokens,
    request: { attemptId: reservationId, model: options.model, messages, tools: [], maxOutputTokens, responseSchema } };
}
