import { learningUsageSettlement } from "../../learning/control/usage-settlement.js";
import type { ContentSemanticRequest } from "../../learning/central/content/process-contract.js";
import { text } from "../../validation/json-shape.js";
import { ContentModelError, type ContentModelReceipt, type ContentSemanticModel, type ContentSemanticModelOptions } from "./model-contract.js";
import { contentModelContext, contentModelResponseFailure, prepareContentModelCall } from "./model-preparation.js";
import { readContentModelStream } from "./model-stream.js";

export { ContentModelError } from "./model-contract.js";
export type { ContentModelReceipt, ContentSemanticModel, ContentSemanticModelOptions } from "./model-contract.js";

/** One funded two-stage attempt. The host supplies its configured single-request provider;
 * this adapter never creates a grant, retries a paid draw, installs a tool or activates an asset. */
export function createContentSemanticModel(options: ContentSemanticModelOptions): ContentSemanticModel {
  if (![options.model, options.jobId, options.grantId, options.claimId].every(value => text(value, 512))) {
    throw new ContentModelError("content_model_identity_invalid");
  }

  const timeoutMs = options.timeoutMs ?? 120000, outputLimit = options.maxOutputTokens ?? 4096;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(outputLimit)
    || outputLimit < 256 || outputLimit > 16384) throw new ContentModelError("content_model_limits_invalid");

  const context = contentModelContext(options), receipts: ContentModelReceipt[] = [];
  const enabled = options.enabled ?? (() => true);
  let phase: "apply_known" | "residual_review" | "busy" | "complete" | "failed" = "apply_known";

  return Object.freeze({
    receipts: () => Object.freeze(receipts.map(receipt => Object.freeze({ ...receipt,
      usage: Object.freeze({ ...receipt.usage }), boundary: Object.freeze({ ...receipt.boundary }) }))),

    async generate(request: ContentSemanticRequest, signal: AbortSignal): Promise<string> {
      if (signal.aborted || !enabled()) throw new ContentModelError("content_model_cancelled");

      if (phase !== request.stage) throw new ContentModelError("content_model_stage_unavailable");

      phase = "busy";

      try {
        const call = await prepareContentModelCall(options, request, { context, outputLimit }, signal);
        const { reservationId, maxTokens } = call;
        const reserved = await options.funding.reserve({ reservationId, maxTokens });
        if (!reserved.ok) throw new ContentModelError(reserved.reason);

        if (reserved.status === "duplicate") throw new ContentModelError("content_model_already_reserved");

        const response = await readContentModelStream({ provider: call.provider, request: call.request, maxTokens, signal, timeoutMs, enabled,
          ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }) });
        const reason = response.reason ?? contentModelResponseFailure(response.text, call.material);
        const receipt = { stage: request.stage, inputHash: request.inputHash, reservationId, grantId: options.grantId, claimId: options.claimId,
          maxTokens, usage: response.usage, boundary: response.boundary,
          response: reason === undefined ? "accepted" as const : response.reason === undefined ? "rejected" as const : "unavailable" as const,
          ...(reason === undefined ? {} : { reason }) };
        let settlement;

        try { settlement = await options.funding.settle({ reservationId, usage: learningUsageSettlement(response.boundary, response.reported
          ? { totalTokens: response.usage.totalTokens, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
              model: options.model } : undefined) }); }
        catch {
          receipts.push({ ...receipt, settlement: "unconfirmed" });
          throw new ContentModelError("content_model_settlement_unconfirmed");
        }

        receipts.push({ ...receipt, settlement: settlement.ok ? "confirmed" : "unconfirmed" });

        if (!settlement.ok) throw new ContentModelError(settlement.reason);

        if (signal.aborted || !enabled()) throw new ContentModelError("content_model_cancelled");

        if (reason !== undefined) throw new ContentModelError(reason);

        phase = request.stage === "apply_known" ? "residual_review" : "complete";

        return response.text;
      } catch (error) {
        phase = "failed";
        throw error instanceof ContentModelError ? error : new ContentModelError("content_model_adapter_failed");
      }
    },
  });
}
