import { err, ok, type Result } from "../../tooling/contract/result.js";
import type { Platform } from "./allowlist.js";
import { fetchJson } from "./fetch-json.js";
import type { AcquisitionFailure } from "./guarded-get.js";
import { adapterOf, PLATFORM_ADAPTERS, type CandidateMetadata, type CandidateRef } from "./platforms/index.js";
import { createHttpsTransport, type HttpTransport } from "./transport.js";

/** Discovery reports platform facts only; audit, download and activation remain separate actions. */
export type ToolSearchFailure = {
  readonly platform: Platform;
  readonly stage: "search" | "metadata";
  readonly code: AcquisitionFailure | "invalid_request";
  readonly message: string;
  readonly ref?: CandidateRef;
};

export type ToolSearchReport = {
  /** failed means no usable metadata and at least one source/metadata failure; an empty clean search is complete. */
  readonly status: "complete" | "partial" | "failed";
  readonly candidates: readonly CandidateMetadata[];
  /** Deduplicated, bounded references, including candidates whose metadata failed. */
  readonly discovered: readonly CandidateRef[];
  readonly failures: readonly ToolSearchFailure[];
  readonly searchedPlatforms: readonly Platform[];
};

export type ToolSearchRequest = {
  readonly capability: string;
  readonly platforms?: readonly Platform[];
  readonly signal?: AbortSignal;
};

export type ToolAcquisitionService = {
  readonly search: (request: ToolSearchRequest) => Promise<Result<ToolSearchReport, "cancelled" | "invalid_request">>;
  readonly metadata: (ref: CandidateRef, signal?: AbortSignal) => Promise<Result<CandidateMetadata, AcquisitionFailure | "invalid_request">>;
};

const DEFAULT_MAX_CANDIDATES = 5;
const MAX_CANDIDATES = 20;
const MAX_CAPABILITY_CHARS = 512;

export function createToolAcquisitionService(options: {
  readonly transport?: HttpTransport;
  readonly maxCandidates?: number;
} = {}): ToolAcquisitionService {
  const transport = options.transport ?? createHttpsTransport();
  const limit = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const metadata: ToolAcquisitionService["metadata"] = async (ref, signal) => {
    if (signal?.aborted) return err("cancelled", "tool discovery was cancelled");
    if (!validRef(ref)) return err("invalid_request", "candidate reference is malformed");
    const adapter = adapterOf(ref.platform);
    if (adapter === undefined) return err("invalid_request", "candidate platform is unsupported");
    const url = adapter.metadataUrl(ref);
    if (!url.ok) return url;
    const payload = await readJson(transport, url.value, signal);
    if (!payload.ok) return payload;
    return adapter.readMetadata(ref, payload.value);
  };

  return {
    metadata,
    search: request => searchPlatforms(request, limit, transport, metadata),
  };
}

async function searchPlatforms(
  request: ToolSearchRequest,
  limit: number,
  transport: HttpTransport,
  metadata: ToolAcquisitionService["metadata"],
): Promise<Result<ToolSearchReport, "cancelled" | "invalid_request">> {
  if (request.signal?.aborted) return err("cancelled", "tool discovery was cancelled");
  const platforms = [...new Set(request.platforms ?? PLATFORM_ADAPTERS.map(adapter => adapter.platform))];
  if (!validRequest(request, limit, platforms)) return err("invalid_request", "capability, platforms or candidate limit is invalid");
  const searched = await Promise.all(platforms.map(async platform => {
    const adapter = adapterOf(platform);
    if (adapter === undefined) return { platform, result: err("search_unsupported", "platform is unsupported") };
    const url = adapter.searchUrl(request.capability.trim());
    if (!url.ok) return { platform, result: url };
    const payload = await readJson(transport, url.value, request.signal);
    return { platform, result: payload.ok ? adapter.readSearch(payload.value) : payload };
  }));
  if (request.signal?.aborted) return err("cancelled", "tool discovery was cancelled");
  const failures: ToolSearchFailure[] = [];
  const references: CandidateRef[] = [];
  for (const { platform, result } of searched) {
    if (!result.ok) {
      if (result.code === "cancelled") return err("cancelled", result.message);
      failures.push({ platform, stage: "search", code: result.code, message: result.message });
    } else {
      references.push(...result.value);
    }
  }
  const discovered = boundedRefs(references, limit);
  const resolved = await Promise.all(discovered.map(async ref => ({ ref, result: await metadata(ref, request.signal) })));
  if (request.signal?.aborted) return err("cancelled", "tool discovery was cancelled");
  const candidates: CandidateMetadata[] = [];
  for (const { ref, result } of resolved) {
    if (result.ok) candidates.push(result.value);
    else {
      if (result.code === "cancelled") return err("cancelled", result.message);
      failures.push({ platform: ref.platform, stage: "metadata", code: result.code, message: result.message, ref });
    }
  }
  const status = failures.length === 0 ? "complete" : candidates.length > 0 ? "partial" : "failed";
  return ok({ status, candidates, discovered, failures, searchedPlatforms: platforms });
}

function validRequest(request: ToolSearchRequest, limit: number, platforms: readonly Platform[]): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_CANDIDATES
    && typeof request.capability === "string" && request.capability.trim().length > 0
    && request.capability.length <= MAX_CAPABILITY_CHARS
    && platforms.length > 0 && platforms.every(platform => adapterOf(platform) !== undefined);
}

function boundedRefs(refs: readonly CandidateRef[], limit: number): readonly CandidateRef[] {
  const found = new Map<string, CandidateRef>();
  for (const ref of refs) {
    const key = JSON.stringify([ref.platform, ref.id, ref.version]);
    if (!found.has(key)) found.set(key, ref);
    if (found.size === limit) break;
  }
  return [...found.values()];
}

function validRef(ref: CandidateRef): boolean {
  if (ref === null || typeof ref !== "object" || typeof ref.id !== "string"
    || ref.id.length === 0 || ref.id.length > 512 || /[\u0000-\u0020?#]/u.test(ref.id)) return false;
  if (ref.version !== undefined && (typeof ref.version !== "string" || ref.version.length === 0
    || ref.version.length > 128 || /[\u0000-\u0020]/u.test(ref.version))) return false;
  if (ref.platform === "github") return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(ref.id)
    && ref.id.split("/").every(part => part !== "." && part !== "..");
  if (ref.platform === "npm") return /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/u.test(ref.id);
  if (ref.platform === "pypi") return /^[A-Za-z0-9_.-]+$/u.test(ref.id);
  return ref.platform === "mcp_registry";
}

async function readJson(transport: HttpTransport, url: string, signal?: AbortSignal): Promise<Result<unknown, AcquisitionFailure>> {
  try {
    return await fetchJson(transport, url, signal);
  } catch {
    // A rejected transport violates its Result contract. Keep private error text out of discovery output.
    return err("network_failure", "tool discovery transport violated its outcome contract");
  }
}
