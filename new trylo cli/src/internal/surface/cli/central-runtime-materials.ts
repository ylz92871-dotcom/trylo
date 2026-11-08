import type { CentralRuntimeMaterial, CentralRuntimeSourcePort, CentralRuntimeSnapshot } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createCentralKnowledgeRecall, createCentralMaterialCapabilities, centralKnowledgeQueryRef,
  readCentralMaterialPageRef } from "../../integration/central-learning/deliberation-material.js";
import { CentralDeliberationError } from "../../integration/central-learning/deliberation-contract.js";
import { createAutomaticBoardContentSource } from "../../integration/learning-content/sources/board.js";
import { pageContentMaterial } from "../../integration/learning-content/sources/artifact-read.js";
import { selectContentFeedbackMaterial } from "../../integration/learning-content/sources/feedback-paging.js";
import { createTaskSourcePageReader, type TaskSourcePageReader } from "../../integration/learning-content/task-source-pages.js";
import { isContentValueCredentialSafe } from "../../integration/learning-content/content-confidentiality-leaf.js";
import { readSessionContentAddress, readSessionTaskAddress } from "../../integration/learning-content/sources/session.js";
import { centralRuntimeSources } from "./central-runtime-sources.js";
import { readSessionPublicTurnAddress } from "../../integration/learning-content/sources/session-public-turn.js";
import { createRuntimeSessionMaterials, type RuntimeBusinessTurn, type RuntimeSessionMaterialsOptions } from "./central-runtime-materials-session.js";
import { readCentralRuntimeRecords, type CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { readConsideredCentralBusinessSourceRefs } from "../../integration/central-learning/runtime-business-source-frontier.js";

export type CentralRuntimeMaterialsOptions = RuntimeSessionMaterialsOptions & { readonly onlyIssueId?: string };

type SnapshotQuery = Parameters<CentralRuntimeSourcePort["snapshot"]>[2];

export type CentralRuntimeBusinessSnapshot = { readonly materials: readonly CentralRuntimeMaterial[];
  readonly sourceRefs: readonly string[]; readonly hasMore: boolean };

export type CentralRuntimeMaterials = CentralRuntimeSourcePort & {
  snapshot(scope: string, signal: AbortSignal, query?: SnapshotQuery): Promise<CentralRuntimeSnapshot & { readonly hasMore: boolean }>;
  readonly pageReader: TaskSourcePageReader;
  owns(scope: string, ref: string): Promise<boolean>;
  businessSnapshot(scope: string, signal: AbortSignal, query?: SnapshotQuery): Promise<CentralRuntimeBusinessSnapshot>;
};

const INITIAL_PAGE_CHARS = 2048;
const HANDOFF_PAGE_CHARS = 4096, HANDOFF_TOTAL_CHARS = 8192;

type InitialPageRead = ReturnType<typeof createCentralMaterialCapabilities>["read"];

async function initialPage(read: InitialPageRead, ref: string, maximumChars: number, signal: AbortSignal) {
  try { return (await read([ref], maximumChars, signal))[0]; }
  catch (error) {
    if (!(error instanceof CentralDeliberationError) || error.reason !== "central_material_capacity") throw error;
    // One page's envelope may not fit; its original catalog remains readable.
    return undefined;
  }
}

/** Share the original preview allowance across the already bounded discovery batch.
 * Complete short originals precede partial pages; all identities and continuations
 * still come from the original reader, never a shortened or synthesized source.
 */
async function initialSourcePages(items: readonly RuntimeBusinessTurn[], read: InitialPageRead, signal: AbortSignal) {
  const candidates: { readonly ref: string; readonly material: CentralRuntimeMaterial; readonly complete: boolean; readonly envelopeChars: number }[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const ref = item.refs[0];
    if (ref === undefined || seen.has(ref)) continue;

    seen.add(ref);
    const material = await initialPage(read, ref, INITIAL_PAGE_CHARS, signal);
    if (material === undefined) continue;

    const page: unknown = JSON.parse(material.text);
    if (typeof page !== "object" || page === null || !("text" in page) || typeof page.text !== "string") {
      throw new CentralDeliberationError("central_material_source_mismatch");
    }

    const complete = "complete" in page && page.complete === true;
    const envelopeChars = material.text.length - JSON.stringify(page.text).length + 2;

    candidates.push({ ref, material, complete, envelopeChars });
  }

  const selected = new Set<string>(), materials: CentralRuntimeMaterial[] = [];
  let remaining = INITIAL_PAGE_CHARS;

  for (const candidate of candidates.filter(item => item.complete).sort((a, b) => a.material.text.length - b.material.text.length)) {
    if (candidate.material.text.length > remaining) continue;
    materials.push(candidate.material);
    selected.add(candidate.ref);
    remaining -= candidate.material.text.length;
  }

  for (const candidate of candidates) {
    if (remaining === 0) break;

    if (selected.has(candidate.ref)) continue;

    // Avoid asking the original reader for a sub-character page when its envelope cannot fit.
    if (remaining < candidate.envelopeChars) continue;

    const material = candidate.material.text.length <= remaining ? candidate.material : await initialPage(read, candidate.ref, remaining, signal);
    if (material === undefined) continue;

    materials.push(material);
    remaining -= material.text.length;
  }

  return materials;
}

/** Read the original owner's public result pages, retaining their origin and
 * continuation. Their existing turn notice is the sole automatic trigger. */
async function initialHandoffPages(items: readonly RuntimeBusinessTurn[], read: InitialPageRead, signal: AbortSignal) {
  const materials: CentralRuntimeMaterial[] = [], notices = new Map<string, string>();
  let remaining = HANDOFF_TOTAL_CHARS;
  const completedAt = (item: RuntimeBusinessTurn) => {
    const at = item.handoffAt === undefined ? 0 : Date.parse(item.handoffAt);
    return Number.isFinite(at) ? at : 0;
  };
  const latest = [...items].sort((left, right) => completedAt(right) - completedAt(left));

  for (const item of latest) for (const ref of item.handoffRefs ?? []) {
    if (remaining === 0) break;
    const material = await initialPage(read, ref, Math.min(HANDOFF_PAGE_CHARS, remaining), signal);
    if (material === undefined || notices.has(material.ref)) continue;
    materials.push(material);
    notices.set(material.ref, item.catalog.noticeRef);
    remaining -= material.text.length;
  }

  return { materials, notices };
}

/** Original source owners supply text, relevance and private-asset visibility. This host owns no learning facts or journal writes. */
export function createCentralRuntimeMaterials(options: CentralRuntimeMaterialsOptions): CentralRuntimeMaterials {
  const advertised = new Set<string>();
  let frontier: { readonly considerations: NonNullable<CentralRuntimeHistory["consideredDeliveries"]>; readonly refs: readonly string[] } | undefined;
  const assertActive = (scope: string, signal: AbortSignal) => {
    if (scope !== options.ctx.cwd) throw new CentralDeliberationError("content_material_scope");
    if (!options.enabled() || signal.aborted) throw new CentralDeliberationError("central_material_cancelled");
  };
  const prepare = async (scope: string, signal: AbortSignal, query?: SnapshotQuery, use: "snapshot" | "read" = "read") => {
    assertActive(scope, signal);
    const identity = options.ctx.workspaceIdentity;
    const ctx = identity === undefined ? options.ctx : { ...options.ctx, workspaceIdentity: { ...identity,
      compatibleRoots: [...identity.compatibleRoots], compatibleWorkspaceIds: [...identity.compatibleWorkspaceIds] } };
    // These source factories freeze their original Board/journal prefix. Recreate at each snapshot, never cache a stale subscription.
    const sources = centralRuntimeSources(ctx, options.workspaceId, { maximumChars: 24000, enabled: options.enabled });
    const loaded = await sources.board.load();
    assertActive(scope, signal);

    if (!loaded.ok) throw new CentralDeliberationError(loaded.reason);

    const inspectionIssueIds = (loaded.state.learningIssues ?? []).filter(issue => issue.scope === scope
      && (options.onlyIssueId === undefined || issue.issueId === options.onlyIssueId)).map(issue => issue.issueId);
    const sessions = createRuntimeSessionMaterials({ ...options, ctx });
    let considered: readonly string[] = [];

    if (use === "snapshot") {
      const considerations = readCentralRuntimeRecords(loaded.state.rewardV2Facts ?? [], scope, loaded.state.sequence).history.consideredDeliveries ?? [];
      // Compare the actual ordered proof prefix, not a count or file timestamp.
      // A verified record hash binds the operation, receipt, result and chain;
      // sequence also preserves the original receipt-before-agenda ordering.
      const extendsPrefix = frontier !== undefined && frontier.considerations.length <= considerations.length
        && frontier.considerations.every((proof, index) => proof.factRef === considerations[index]!.factRef
          && proof.sequence === considerations[index]!.sequence);
      const previous = extendsPrefix ? frontier! : { considerations: [], refs: [] };
      if (!extendsPrefix || previous.considerations.length !== considerations.length) {
        const added = readConsideredCentralBusinessSourceRefs({ facts: loaded.state.rewardV2Facts ?? [], boardSequence: loaded.state.sequence,
          scope, considerations: considerations.slice(previous.considerations.length),
          ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });
        frontier = { considerations, refs: [...new Set([...previous.refs, ...added])] };
      }

      // Each newly returned agenda decodes only its new original receipts.
      // A reset/divergent prefix rebuilds from evidence instead of retaining a stale frontier.
      considered = frontier!.refs;
    }

    const discovered = await sessions.catalogs(signal, query?.sourceRefs, 8, considered);
    const boardOptions = { board: { load: async () => loaded }, scope, domain: "prompt" as const, enabled: options.enabled,
      maximumChars: 12000, maximumCandidates: 24, maximumSelected: 4,
      nativeAccess: { inspectionIssueIds } };
    const board = createAutomaticBoardContentSource({ ...boardOptions, taskPurpose: discovered.items[0]?.taskPurpose ?? "" });
    const directoryItems = [...discovered.items, ...discovered.consideredItems];
    const catalogs = directoryItems.map(item => businessCatalog(item.catalog));
    const aliases = new Map<string, CentralRuntimeMaterial>();

    for (const [index, catalog] of catalogs.entries()) {
      aliases.set(catalog.ref, catalog);
      aliases.set(directoryItems[index]!.catalog.noticeRef, catalog);
    }

    for (const failure of sessions.sourceFailures()) aliases.set(failure.ref, failure);

    const pages = createTaskSourcePageReader({ session: sessions.reader,
      board: { async readMaterial(ref, cancellation, start = 0, maximumChars = 4096) {
        assertActive(scope, cancellation);
        const catalog = aliases.get(ref);
        if (catalog === undefined) return board.readMaterial(ref, cancellation, start, maximumChars);
        return pageContentMaterial({ ref: catalog.ref, requestedRef: ref, text: catalog.text, originalScope: scope,
          sourceRefs: catalog.sourceRefs, origin: "execution_result", admissibility: "source_record",
          coordinate: { runId: ref, sequence: 0 }, ...(options.secrets === undefined ? {} : { secrets: options.secrets }) }, start, maximumChars);
      } }, feedback: selectContentFeedbackMaterial({ scope, batches: [] }) });
    const recall = createCentralKnowledgeRecall({ ...boardOptions, ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });
    const capabilities = createCentralMaterialCapabilities({ scope, enabled: options.enabled,
      resolvePage: (input, cancellation) => pages.read(input.ref, cancellation, input.start, input.maximumChars), recall,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });

    return { loaded, discovered, directoryItems, catalogs, aliases, capabilities, pages, sessions };
  };
  const snapshot = async (scope: string, signal: AbortSignal, query?: SnapshotQuery): Promise<CentralRuntimeSnapshot & { readonly hasMore: boolean }> => {
      const source = await prepare(scope, signal, query, "snapshot");
      const handoff = await initialHandoffPages(source.discovered.items, source.capabilities.read, signal);
      const materials = [...handoff.materials, ...await initialSourcePages(source.discovered.items, source.capabilities.read, signal)];

      materials.push(...source.catalogs);
      assertActive(scope, signal);
      const reconsider = await source.sessions.reconsider(query, signal);
      assertActive(scope, signal);
      materials.push(...source.sessions.sourceFailures(query?.sourceRefs));
      // A directory consumes its source-owned notice, never every body address it advertises.
      const catalogPositions = new Map(source.catalogs.map((catalog, index) => [catalog.ref, source.directoryItems[index]!.catalog.noticeRef]));
      const automatic = new Set(source.discovered.items.map(item => item.catalog.noticeRef));
      const observed = { boardSequence: source.loaded.state.sequence, opportunities: [], materials, hasMore: source.discovered.hasMore, reconsider,
        providerPositiveNotes: source.sessions.providerPositiveNotes(),
        sourceRefs: [...new Set(materials.flatMap(item => {
          const handoffNotice = handoff.notices.get(item.ref);
          if (handoffNotice !== undefined) return [handoffNotice];
          const position = catalogPositions.get(item.ref);
          return position === undefined ? [item.ref, ...item.sourceRefs] : automatic.has(position) ? [position] : [];
        }))] };
      if (!isContentValueCredentialSafe(observed, options.secrets ?? [])) throw new CentralDeliberationError("central_material_sensitive");

      for (const material of materials) {
        advertised.add(material.ref);
        for (const ref of material.sourceRefs) advertised.add(ref);
      }

      return observed;
  };
  const pageReader: TaskSourcePageReader = { async read(ref, signal, start, maximumChars) {
    try {
      const source = await prepare(options.ctx.cwd, signal), page = await source.pages.read(ref, signal, start, maximumChars);
      assertActive(options.ctx.cwd, signal);
      return page.ok && !isContentValueCredentialSafe(page.value, options.secrets ?? [])
        ? { ok: false, reason: "central_material_sensitive" } : page;
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "content_material_unavailable" };
    }
  } };
  const owns = async (scope: string, ref: string, depth = 0): Promise<boolean> => {
    if (scope !== options.ctx.cwd || !options.enabled() || depth > 4) return false;

    try {
      const page = readCentralMaterialPageRef(ref);
      if (page !== undefined) return owns(scope, page.ref, depth + 1);
      if (readSessionContentAddress(ref) !== undefined || readSessionTaskAddress(ref) !== undefined || readSessionPublicTurnAddress(ref) !== undefined) return true;
      if (ref.startsWith("central-known:")) return centralKnowledgeQueryRef(decodeURIComponent(ref.slice("central-known:".length))) === ref;
    } catch { return false; } // An invalid wrapper or query cannot prove ownership of a peer's underlying source.

    return advertised.has(ref);
  };

  return {
    snapshot, pageReader, owns,

    async businessSnapshot(scope, signal, query) {
      const observed = await snapshot(scope, signal, query);
      return { materials: observed.materials, sourceRefs: observed.sourceRefs, hasMore: observed.hasMore };
    },

    async read(scope, refs, maximumChars, signal) {
      const source = await prepare(scope, signal);
      const result = await source.capabilities.read(refs, maximumChars, signal);

      assertActive(scope, signal);
      const exposed = result.map(material => {
        const catalog = source.catalogs.find(item => material.kind === "source" && material.sourceRefs.includes(item.ref));
        return catalog === undefined ? material : { ...material, sourceRefs: [...new Set([...material.sourceRefs, ...catalog.sourceRefs])] };
      });

      for (const material of exposed) {
        advertised.add(material.ref);
        for (const ref of material.sourceRefs) advertised.add(ref);
      }

      return exposed;
    },
  };
}

function businessCatalog(catalog: RuntimeBusinessTurn["catalog"]): CentralRuntimeMaterial {
  const text = canonicalJson({ role: "host_normal_turn_source_catalog_not_read_body", ...catalog });
  return { ref: `central-business-catalog:${contentHashOf(text)}`, kind: "source", text,
    sourceRefs: [catalog.noticeRef, ...catalog.entries.flatMap(row => [row.ref, row.address])] };
}
