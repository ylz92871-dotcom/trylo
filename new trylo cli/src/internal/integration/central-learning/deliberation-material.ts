import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, sequence, text } from "../../validation/json-shape.js";
import type { TaskSourcePage, TaskSourcePageRead } from "../learning-content/task-source-pages.js";
import { createAutomaticBoardContentSource } from "../learning-content/sources/board.js";
import type { BoardTaskReferenceInput } from "../learning-content/sources/board-contract.js";
import { isContentValueCredentialSafe } from "../learning-content/content-confidentiality-leaf.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { CENTRAL_RUNTIME_LIMITS, isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { readSessionPublicTurnAddress } from "../learning-content/sources/session-public-turn.js";

const PAGE_PREFIX = "central-page:", KNOWLEDGE_PREFIX = "central-known:";

/** An address is a read request, never evidence that a page has already been seen. */
export function centralMaterialPageRef(ref: string, start: number): string {
  if (!text(ref, 2048) || !sequence(start)) throw new CentralDeliberationError("central_material_address_invalid");
  const address = `${PAGE_PREFIX}${start}:${ref}`;
  if (!text(address, 512)) throw new CentralDeliberationError("central_material_address_capacity");
  return address;
}

export function readCentralMaterialPageRef(value: string): { readonly ref: string; readonly start: number } | undefined {
  if (!value.startsWith(PAGE_PREFIX)) return undefined;

  const compact = /^central-page:(\d+):(.+)$/.exec(value);
  if (compact !== null) {
    const start = Number(compact[1]);
    if (!sequence(start) || !text(compact[2], 2048)) throw new CentralDeliberationError("central_material_address_invalid");
    return { ref: compact[2], start };
  }

  let decoded: unknown;

  try { decoded = JSON.parse(decodeURIComponent(value.slice(PAGE_PREFIX.length))); }
  catch { throw new CentralDeliberationError("central_material_address_invalid"); }

  if (!fields(decoded, ["ref", "start"]) || !text(decoded.ref, 2048) || !sequence(decoded.start)) {
    throw new CentralDeliberationError("central_material_address_invalid");
  }

  return { ref: decoded.ref, start: decoded.start };
}

export function centralKnowledgeQueryRef(purpose: string): string {
  if (!text(purpose, 8192)) throw new CentralDeliberationError("central_knowledge_query_invalid");
  const address = `${KNOWLEDGE_PREFIX}${encodeURIComponent(purpose)}`;
  if (!text(address, 512)) throw new CentralDeliberationError("central_knowledge_query_capacity");
  return address;
}

export function centralMaterialFromPage(page: TaskSourcePage): CentralRuntimeMaterial {
  const continuation = page.owner === "session" && readSessionPublicTurnAddress(page.originalRef) !== undefined ? page.originalRef : page.ref;
  return { ref: `central-source-page:${contentHashOf(page)}`, kind: "source", sourceRefs: [page.originalRef],
    text: canonicalJson({ role: "actual_source_fragment_not_full_source", ...page,
      complete: page.start === 0 && page.end === page.totalChars,
      ...(page.end >= page.totalChars ? {} : { nextRef: centralMaterialPageRef(continuation, page.end) }) }) };
}

/** Budget the complete public envelope. Only original text is shortened; each
 * candidate gets the canonical page identity and continuation for its real end. */
function boundedCentralMaterialFromPage(page: TaskSourcePage, maximumChars: number): CentralRuntimeMaterial {
  const whole = centralMaterialFromPage(page);
  if (whole.text.length <= maximumChars) return whole;

  let lower = 1, upper = page.text.length - 1, selected: CentralRuntimeMaterial | undefined;

  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    let length = middle;
    const last = page.text.charCodeAt(length - 1);
    if (last >= 0xd800 && last <= 0xdbff) length -= 1;

    const material = centralMaterialFromPage({ ...page, end: page.start + length, text: page.text.slice(0, length) });
    if (material.text.length <= maximumChars) {
      if (length > 0) selected = material;
      lower = middle + 1;
    } else upper = middle - 1;
  }

  // An empty page is no progress, including when metadata alone cannot fit.
  if (selected === undefined) throw new CentralDeliberationError("central_material_capacity");

  return selected;
}

/** Uses the original source-owned native visibility, scope/liveness checks and bounded relevance selection. */
export function createCentralKnowledgeRecall(options: Omit<BoardTaskReferenceInput, "taskPurpose"> & { readonly secrets?: readonly string[] }) {
  return async (purpose: string, signal: AbortSignal): Promise<CentralRuntimeMaterial> => {
    if (!text(purpose, 8192)) throw new CentralDeliberationError("central_knowledge_query_invalid");

    const result = await createAutomaticBoardContentSource({ ...options, taskPurpose: purpose,
      maximumChars: options.maximumChars ?? 12000 }).readTaskReferences(signal);
    if (!result.ok) throw new CentralDeliberationError(result.reason);

    if (!isContentValueCredentialSafe(result.value.batch, options.secrets ?? [])) throw new CentralDeliberationError("central_material_sensitive");

    return { ref: `central-knowledge:${contentHashOf({ purpose, coverage: result.value.coverage, batch: result.value.batch })}`,
      kind: "knowledge", sourceRefs: result.value.batch.records.map(row => row.ref),
      text: result.value.materialJson };
  };
}

export function createCentralMaterialCapabilities(options: { readonly scope: string; readonly enabled: () => boolean;
  readonly resolvePage: (input: { readonly ref: string; readonly start: number; readonly maximumChars: number }, signal: AbortSignal) => Promise<TaskSourcePageRead>;
  readonly recall?: (purpose: string, signal: AbortSignal) => Promise<CentralRuntimeMaterial>;
  readonly secrets?: readonly string[] }) {
  return { async read(refs: readonly string[], maximumChars: number, signal: AbortSignal): Promise<readonly CentralRuntimeMaterial[]> {
    if (signal.aborted || !options.enabled()) throw new CentralDeliberationError("central_material_cancelled");

    if (!Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 131072 || refs.length > 32) {
      throw new CentralDeliberationError("central_material_capacity");
    }

    const materials: CentralRuntimeMaterial[] = [];
    let remaining = maximumChars;

    for (const ref of refs) {
      if (signal.aborted || !options.enabled()) throw new CentralDeliberationError("central_material_cancelled");

      if (remaining < 1) break;

      if (ref.startsWith(KNOWLEDGE_PREFIX)) {
        if (options.recall === undefined) throw new CentralDeliberationError("central_knowledge_unavailable");

        let purpose: string;

        try { purpose = decodeURIComponent(ref.slice(KNOWLEDGE_PREFIX.length)); }
        catch { throw new CentralDeliberationError("central_knowledge_query_invalid"); }

        const material = await options.recall(purpose, signal);
        if (!isCentralRuntimeMaterial(material) || material.text.length > remaining) throw new CentralDeliberationError("central_material_capacity");

        if (!isContentValueCredentialSafe(material, options.secrets ?? [])) throw new CentralDeliberationError("central_material_sensitive");

        materials.push(material);
        remaining -= material.text.length;
        continue;
      }

      const address = readCentralMaterialPageRef(ref) ?? { ref, start: 0 };
      const result = await options.resolvePage({ ...address, maximumChars: Math.min(8192, remaining) }, signal);
      if (!result.ok) throw new CentralDeliberationError(result.reason);

      const page = result.value;
      if (page.originalScope !== options.scope || page.ref !== address.ref || page.start !== address.start
        || ![page.start, page.end, page.totalChars].every(sequence) || page.end <= page.start
        || !/^[a-f0-9]{64}$/.test(page.sourceHash) || page.end - page.start !== page.text.length
        || page.text.length > Math.min(8192, remaining) || page.end > page.totalChars) throw new CentralDeliberationError("central_material_source_mismatch");

      if (!isContentValueCredentialSafe(page, options.secrets ?? [])) throw new CentralDeliberationError("central_material_sensitive");

      const material = boundedCentralMaterialFromPage(page, Math.min(remaining, CENTRAL_RUNTIME_LIMITS.textChars));

      materials.push(material);
      remaining -= material.text.length;
    }

    if (signal.aborted || !options.enabled()) throw new CentralDeliberationError("central_material_cancelled");

    return materials;
  } };
}
