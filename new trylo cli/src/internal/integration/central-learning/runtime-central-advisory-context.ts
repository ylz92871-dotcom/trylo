import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { text } from "../../validation/json-shape.js";
import { isContentValueCredentialSafe } from "../learning-content/content-confidentiality-leaf.js";
import type { CentralAdvisoryPublish } from "./central-advisory-contracts.js";
import { readCentralAdvisory, readCentralAdvisoryRecords } from "./central-advisory-records.js";
import { readCentralAdvisoryResultMaterial } from "../../learning/central/runtime/advisory-material.js";
import { centralAdvisoryContextMaterials, centralAdvisoryPublicationMaterial,
  readCentralAdvisoryResultContextMaterial } from "./central-advisory-material.js";

export interface RuntimeCentralAdvisoryContextOptions {
  readonly boardRoot: string;
  readonly scope: string;
  readonly enabled: () => boolean;
  readonly access: (board: BoardState, publication: CentralAdvisoryPublish,
    signal: AbortSignal) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
  readonly secrets?: readonly string[];
}

export interface RuntimeCentralAdvisoryContext {
  recall(input: { readonly scope: string; readonly boardSequence: number }, signal: AbortSignal): Promise<readonly CentralRuntimeMaterial[]>;
  readonly source: CentralRuntimeSourcePort & { owns(scope: string, ref: string): Promise<boolean> };
}

const fail = (reason: string): never => { throw new Error(reason); };
const reference = (ref: string): boolean => text(ref, 512) && !/[\u0000-\u001f]/.test(ref);

/** Original handoff refusals are execution returns to their live purpose.
 * They are offered once by immutable receipt identity, without creating a
 * business opportunity, writing the Board or bypassing source-owner access. */
export function createRuntimeCentralAdvisoryContext(options: RuntimeCentralAdvisoryContextOptions): RuntimeCentralAdvisoryContext {
  const reader = createBoardReader(options.boardRoot);

  function check(scope: string, signal?: AbortSignal): void {
    if (scope !== options.scope) fail("central_advisory_context_scope_mismatch");
    if (signal?.aborted === true) fail("learning_aborted");
    if (!options.enabled()) fail("collect_disabled");
  }

  async function load(scope: string, signal?: AbortSignal): Promise<BoardState> {
    check(scope, signal);
    const loaded = await reader.load();
    check(scope, signal);
    if (!loaded.ok) return fail(loaded.reason);
    return loaded.state;
  }

  function safe(rows: readonly CentralRuntimeMaterial[]): readonly CentralRuntimeMaterial[] {
    if (!isContentValueCredentialSafe(rows, options.secrets ?? [])) fail("central_advisory_context_sensitive");
    return rows;
  }

  const source: RuntimeCentralAdvisoryContext["source"] = {
    async snapshot(scope, signal, query) {
      check(scope, signal);

      if (query?.purposes === undefined || query.purposes.length === 0) {
        return { boardSequence: 0, opportunities: [], materials: [], sourceRefs: [] };
      }

      const board = await load(scope, signal), known = new Set(query.sourceRefs ?? []);
      const seen = new Set<string>(), selected: CentralRuntimeMaterial[] = [];
      const reconsider: NonNullable<Awaited<ReturnType<CentralRuntimeSourcePort["snapshot"]>>["reconsider"]>[number][] = [];

      for (const row of centralAdvisoryContextMaterials(board, scope)) {
        const result = readCentralAdvisoryResultMaterial(row);
        if (result === undefined) continue;

        const ids = [...new Set(result.entries.flatMap(entry => entry.intentId === null ? [] : [entry.intentId]))];
        const current = ids.filter(id => !seen.has(id));
        ids.forEach(id => seen.add(id));
        const failed = current.filter(id => result.entries.some(entry => entry.intentId === id
          && (entry.status === "rejected" || entry.status === "superseded")));
        const purposes = query.purposes.filter(purpose => failed.some(id => purpose.sourceRefs.includes(id)));
        if (purposes.length === 0 || known.has(row.ref) || known.has(result.resultRef)) continue;

        selected.push(row);

        for (const purpose of purposes) reconsider.push({ subject: purpose.subject, sourceRefs: [row.ref],
          reason: "original_central_advisory_handoff_refused_not_published" });
      }

      return { boardSequence: board.sequence, opportunities: [], materials: safe(selected),
        sourceRefs: selected.map(row => row.ref), reconsider };
    },

    async owns(scope, ref) {
      if (scope !== options.scope || !reference(ref)) return false;
      const board = await load(scope);
      return readCentralAdvisoryRecords(board.rewardV2Facts ?? [], scope, board.sequence)
        .some(row => row.ref === ref && row.value.kind === "publish")
        || readCentralAdvisoryResultContextMaterial(board, scope, ref) !== undefined;
    },

    async read(scope, refs, maximumChars, signal) {
      check(scope, signal);

      if (!Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 100000
        || refs.length > 64 || !refs.every(reference)) fail("central_advisory_context_capacity");

      const board = await load(scope, signal), facts = board.rewardV2Facts ?? [];
      const records = readCentralAdvisoryRecords(facts, scope, board.sequence), selected: CentralRuntimeMaterial[] = [];
      let remaining = maximumChars;

      for (const ref of new Set(refs)) {
        check(scope, signal);
        const record = records.find(row => row.ref === ref && row.value.kind === "publish");
        let row: CentralRuntimeMaterial | undefined;

        if (record?.value.kind === "publish") {
          const publication = readCentralAdvisory(board, scope, { ref: record.value.advisoryId, version: record.ref });
          if (publication === undefined) return fail("central_advisory_context_missing");
          const access = await options.access(board, record.value, signal);
          check(scope, signal);
          if (!access.ok) fail("central_advisory_context_access_denied");
          row = centralAdvisoryPublicationMaterial(scope, publication);
        } else row = readCentralAdvisoryResultContextMaterial(board, scope, ref);

        if (row === undefined) return fail("central_advisory_context_missing");

        if (row.text.length > remaining) fail("central_advisory_context_capacity");

        selected.push(row);
        remaining -= row.text.length;
      }

      check(scope, signal);
      return safe(selected);
    },
  };

  return {
    async recall(input, signal) {
      check(input.scope, signal);

      if (!Number.isSafeInteger(input.boardSequence) || input.boardSequence < 0) fail("central_advisory_context_sequence_invalid");

      const board = await load(input.scope, signal);
      if (input.boardSequence > board.sequence) fail("central_advisory_context_sequence_unavailable");

      const prefix = { ...board, sequence: input.boardSequence,
        rewardV2Facts: (board.rewardV2Facts ?? []).filter(fact => fact.sequence <= input.boardSequence) };
      const rows = centralAdvisoryContextMaterials(prefix, input.scope);
      check(input.scope, signal);
      return safe(rows);
    },

    source,
  };
}
