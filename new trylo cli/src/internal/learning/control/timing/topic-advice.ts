import { fields, identity, sequence } from "../../../validation/json-shape.js";
import { contentHashOf } from "../hash.js";
import { isTopicBudgetBid } from "../topic-allocation.js";
import type { TopicBudgetBid } from "../topic-bid.js";
import { failTiming, requireTiming, runTimingJson } from "./boundary.js";
import type { TimingFailure } from "./boundary.js";
import type { PredictiveTimingAnalysis } from "./predictive.js";
import { evaluatePredictiveTimingModel, readPredictiveTimingOptions } from "./predictive.js";

/** Ephemeral request identity. It is not an allocation, grant or execution handle. */
export interface TopicTimingBasis {
  readonly schemaVersion: 1;
  readonly basisRef: string;
  readonly bidHash: string;
  readonly valuationId: string;
  readonly domain: TopicBudgetBid["domain"];
  readonly scope: string;
  readonly sourceBasis: TopicBudgetBid["basis"];
  readonly utilityUnit: string;
  readonly quotaUnit: string;
  readonly quota: number;
  /** Original local quote; not inserted into the complete timing value. */
  readonly quotedNetValue: number;
  readonly contextRef: string;
  readonly evaluationRef: string;
}

export interface TopicTimingRequest {
  readonly schemaVersion: 1;
  readonly bid: TopicBudgetBid;
  readonly quota: number;
  /** Caller-owned current history/progress/business/resource/model conditions. */
  readonly contextRef: string;
  readonly evaluationRef: string;
  /** null requests identity only; other declarations are checked by the predictive compiler. */
  readonly model: unknown;
}

export type TopicTimingAnalysis =
  | { readonly status: "requires_timing_model"; readonly basis: TopicTimingBasis;
      readonly reason: "conditional_timing_model_not_provided" }
  | { readonly status: "analyzed_topic_timing"; readonly basis: TopicTimingBasis;
      readonly analysis: PredictiveTimingAnalysis };

function readRequest(raw: unknown): TopicTimingRequest {
  requireTiming(fields(raw, ["schemaVersion", "bid", "quota", "contextRef", "evaluationRef", "model"]),
    "topic_request_shape", "request");
  requireTiming(raw.schemaVersion === 1 && isTopicBudgetBid(raw.bid), "topic_bid_invalid", "request.bid");
  requireTiming(sequence(raw.quota) && raw.quota < raw.bid.curve.length,
    "quoted_quota_required", "request.quota");
  requireTiming(identity(raw.contextRef) && identity(raw.evaluationRef), "topic_context_required", "request");

  return { schemaVersion: 1, bid: raw.bid, quota: raw.quota,
    contextRef: raw.contextRef, evaluationRef: raw.evaluationRef, model: raw.model };
}

function requestBasis(request: TopicTimingRequest): TopicTimingBasis {
  const bid = request.bid;
  const body = { schemaVersion: 1 as const, bidHash: contentHashOf(bid), valuationId: bid.valuationId,
    domain: bid.domain, scope: bid.scope, sourceBasis: bid.basis,
    utilityUnit: bid.utilityUnit, quotaUnit: bid.quotaUnit, quota: request.quota,
    quotedNetValue: bid.curve[request.quota]!.netValue,
    contextRef: request.contextRef, evaluationRef: request.evaluationRef };

  return { ...body, basisRef: `topic-timing:${contentHashOf(body)}` };
}

function requireMatchingHeader(model: unknown, basis: TopicTimingBasis): void {
  requireTiming(typeof model === "object" && model !== null && !Array.isArray(model),
    "timing_model_object_required", "request.model");
  // Full model shape belongs to the predictive compiler; this boundary checks
  // its response identity before spending work on that declaration.
  const header = model as Record<string, unknown>;

  requireTiming(identity(header.basisRef) && identity(header.sourceScope)
    && identity(header.evaluationRef) && identity(header.utilityUnit), "timing_header_required", "request.model");

  if (header.basisRef !== basis.basisRef || header.sourceScope !== basis.scope
    || header.evaluationRef !== basis.evaluationRef || header.utilityUnit !== basis.utilityUnit) {
    failTiming("binding_mismatch", "topic_timing_basis_mismatch", "request.model");
  }
}

/** Analyze data already received. No preparation, allocation or execution is called.
 * contextRef freshness and conditional model truth remain caller/source premises.
 */
export function analyzeTopicLearningTiming(json: unknown, options?: unknown): TopicTimingAnalysis | TimingFailure {
  return runTimingJson(json, raw => {
    const limits = readPredictiveTimingOptions(options);
    const request = readRequest(raw), basis = requestBasis(request);
    if (request.model === null) {
      return { status: "requires_timing_model" as const, basis,
        reason: "conditional_timing_model_not_provided" as const };
    }

    requireMatchingHeader(request.model, basis);

    return { status: "analyzed_topic_timing" as const, basis,
      analysis: evaluatePredictiveTimingModel(request.model, limits) };
  });
}
