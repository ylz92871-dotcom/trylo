import type { CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, type CentralRuntimeRead } from "../../learning/central/runtime/records.js";
import { isCentralLearningRuntimeState, isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { compactCentralWorkingSet } from "../../learning/central/runtime/working-set.js";
import { mergeRuntimeMaterials } from "../../learning/central/runtime/transitions.js";
import { CentralRuntimeCheckpointBusyError, CentralRuntimeHeadChangedError, isCentralRuntimeCheckpointContention, saveCentralRuntimeCheckpoint } from "./runtime-checkpoint.js";
import type { createCentralRuntimeStore } from "./runtime-store.js";

type ArchiveStore = Pick<ReturnType<typeof createCentralRuntimeStore>, "read" | "append" | "lookupMany">
  & Partial<Pick<ReturnType<typeof createCentralRuntimeStore>, "appendMaterial">>;

export type CentralRuntimeArchiveResult = { readonly status: "archived"; readonly cursor: CentralRuntimeRead }
  | { readonly status: "capacity"; readonly cursor: CentralRuntimeRead; readonly materialRef: string }
  | { readonly status: "contended"; readonly cursor: CentralRuntimeRead };

const REASON = "central_original_source_observed_not_model_delivery";

/** Capacity applies to the complete original record, not a material count. */
function candidate(cursor: CentralRuntimeRead, pending: readonly CentralRuntimeMaterial[]): CentralLearningRuntimeState | undefined {
  const state = compactCentralWorkingSet(cursor.state,
    { ...cursor.state, materials: mergeRuntimeMaterials(cursor.state.materials, pending) },
    cursor.history.consumedSourceRefs, cursor.history.materials.map(row => row.ref));

  if (!isCentralLearningRuntimeState(state)) return undefined;

  for (const material of pending) {
    if (!state.materials.includes(material)) throw new Error("central_runtime_source_missing");
  }

  try { buildCentralRuntimeRecord({ previousRef: cursor.stateRef, state, reason: REASON, sourceRefs: pending.map(row => row.ref) }); }
  catch (error) {
    if (error instanceof Error && error.message === "central_runtime_record_capacity") return undefined;
    throw error;
  }

  return state;
}

/** Validate archived identities once from the original chain. No material is
 * delivered or observed by this read-only check, and no index is persisted. */
async function freshMaterials(store: ArchiveStore, cursor: CentralRuntimeRead, materials: readonly CentralRuntimeMaterial[]) {
  const incoming = mergeRuntimeMaterials(materials);

  if (!incoming.every(isCentralRuntimeMaterial)) throw new Error("central_runtime_state_capacity_or_shape");

  const archived = new Map(cursor.history.materials.map(row => [row.ref, row]));
  const originals = new Map(cursor.state.materials.map(row => [row.ref, row]));
  const queries = incoming.flatMap(material => {
    const previous = archived.get(material.ref);
    return previous === undefined || originals.has(material.ref) ? [] : [{ kind: "material" as const, ref: material.ref, factRef: previous.factRef }];
  });

  if (queries.length > 0) {
    const found = await store.lookupMany(cursor.state.scope, queries);

    if (found.length !== queries.length) throw new Error("central_runtime_source_missing");

    for (const [index, result] of found.entries()) {
      const query = queries[index]!;
      if (result.status !== "found" || result.factRef !== query.factRef || !isCentralRuntimeMaterial(result.value)
        || result.value.ref !== query.ref) throw new Error("central_runtime_source_missing");
      originals.set(query.ref, result.value);
    }
  }

  for (const material of incoming) {
    if (!archived.has(material.ref)) continue;
    const previous = originals.get(material.ref);
    if (previous === undefined) throw new Error("central_runtime_source_missing");
    mergeRuntimeMaterials([previous], [material]);
  }

  return incoming.filter(material => !archived.has(material.ref));
}

/** Archive original whole bodies through the same checkpoint writer. */
export async function archiveCentralRuntimeMaterials(store: ArchiveStore, cursor: CentralRuntimeRead,
  materials: readonly CentralRuntimeMaterial[], mode: "checkpoint" | "independent" = "checkpoint"): Promise<CentralRuntimeArchiveResult> {
  if (mode === "independent" && store.appendMaterial === undefined) throw new Error("central_runtime_material_archive_unavailable");
  let remaining = await freshMaterials(store, cursor, materials), contention = 0;

  while (remaining.length > 0) {
    // A source need not coexist with every active purpose and receipt merely
    // to become durable. Keep the original Board and exact-lookup namespace;
    // only the immutable body's storage is independent of working memory.
    if (store.appendMaterial !== undefined && (mode === "independent" || candidate(cursor, [remaining[0]!]) === undefined)) {
      const material = remaining[0]!;

      try {
        const saved = await store.appendMaterial({ expectedRevision: cursor.revision, scope: cursor.state.scope, material });

        cursor = await store.read(cursor.state.scope);
        const unarchived = await freshMaterials(store, cursor, remaining);

        if (saved.status === "written" && unarchived.some(row => row.ref === material.ref)) throw new Error("central_runtime_archive_unconfirmed");

        remaining = unarchived;

        if (saved.status === "stale") {
          if (++contention >= 4) return { status: "contended", cursor };
        } else contention = 0;
      } catch (error) {
        if (isCentralRuntimeCheckpointContention(error)) return { status: "contended", cursor };
        if (error instanceof Error && error.message === "central_runtime_material_record_capacity") {
          return { status: "capacity", cursor, materialRef: material.ref };
        }
        throw error; // An unknown append is never blindly replayed.
      }

      continue;
    }

    const pending: CentralRuntimeMaterial[] = [];
    let staged: CentralLearningRuntimeState | undefined;

    for (const material of remaining) {
      const state = candidate(cursor, [...pending, material]);
      if (state === undefined) {
        if (pending.length === 0) return { status: "capacity", cursor, materialRef: material.ref };
        break;
      }
      pending.push(material);
      staged = state;
    }

    if (staged === undefined) throw new Error("central_runtime_source_missing");

    try {
      const saved = await saveCentralRuntimeCheckpoint(store, cursor, staged, REASON, pending.map(row => row.ref));
      // Another intake may follow our confirmed append. Verify the original
      // bodies in that actual prefix; never copy an old semantic state over it.
      if ((await freshMaterials(store, saved, pending)).length > 0) throw new Error("central_runtime_archive_unconfirmed");
      cursor = saved;
      contention = 0;
    } catch (error) {
      if (error instanceof CentralRuntimeCheckpointBusyError) return { status: "contended", cursor };

      if (!(error instanceof CentralRuntimeHeadChangedError)) throw error;

      cursor = error.current;
      // Only immutable source archival is rebased. Intent/operation selection
      // remains the driver's responsibility before any provider is issued.
      remaining = await freshMaterials(store, cursor, remaining);

      if (++contention >= 4) return { status: "contended", cursor };

      continue;
    }

    remaining = await freshMaterials(store, cursor, remaining);
  }

  return { status: "archived", cursor };
}
