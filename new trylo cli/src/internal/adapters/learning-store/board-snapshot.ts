import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import { normalizeBoardState, type BoardState } from "../../learning/control/state.js";

export const BOARD_SNAPSHOT_FILE = "board-snapshot.json";

export type BoardSnapshotFile = {
  readonly schemaVersion?: 2 | 3;
  readonly generation: number;
  readonly sequence: number;
  readonly checksum: string;
  readonly state: BoardState;
};

const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The original state decoder remains the authority for snapshot namespaces.
 * Check the required container before entering that typed legacy decoder. */
export function snapshotState(value: unknown): value is BoardState {
  if (typeof value !== "object" || value === null || !("sequence" in value) || !integer(value.sequence)) return false;

  const body = value as Record<string, unknown>;
  const logicalSequence = value.sequence;

  if (!["appliedCommands", "proposals", "assets", "activations", "evidence", "approvals", "jobs", "tombstones"]
    .every(key => Array.isArray(body[key]))) return false;

  const applied = body.appliedCommands as unknown[];
  if (!applied.every(row => typeof row === "object" && row !== null && "commandId" in row && typeof row.commandId === "string"
    && "sequence" in row && integer(row.sequence) && row.sequence <= logicalSequence
    && (!("payloadHash" in row) || typeof row.payloadHash === "string" && /^[a-f0-9]{64}$/.test(row.payloadHash)))) return false;

  return normalizeBoardState(value as BoardState) !== undefined;
}

/** Legacy checksum bytes and schema discrimination are intentionally unchanged. */
export function snapshotChecksum(file: BoardSnapshotFile): string {
  return sha256Hex(canonicalJson({ ...(file.schemaVersion === undefined ? {} : { schemaVersion: file.schemaVersion }),
    generation: file.generation, sequence: file.sequence, state: file.state }));
}

export function snapshotVersion(state: BoardState): { readonly schemaVersion?: 2 | 3 } {
  return (state.centralLearningBudgets?.length ?? 0) > 0 ? { schemaVersion: 3 }
    : (state.methodExperienceFacts?.length ?? 0) > 0 ? { schemaVersion: 2 } : {};
}

export function decodeBoardSnapshot(raw: string): BoardSnapshotFile | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("generation" in value) || !integer(value.generation)
      || !("sequence" in value) || !integer(value.sequence) || !("checksum" in value) || typeof value.checksum !== "string"
      || !("state" in value) || !snapshotState(value.state)
      || "schemaVersion" in value && value.schemaVersion !== 2 && value.schemaVersion !== 3) return undefined;

    const file = value as BoardSnapshotFile;
    if (snapshotChecksum(file) !== file.checksum) return undefined;

    const state = normalizeBoardState(file.state);

    return state === undefined ? undefined : { ...file, state };
  } catch {
    // A damaged disposable snapshot must use the original log recovery path.
    return undefined;
  }
}
