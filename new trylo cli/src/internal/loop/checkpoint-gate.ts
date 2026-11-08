import type { CheckpointPort, CheckpointResult, SnapshotOutcome } from "../ports/checkpoint.js";
import type { JsonObject } from "../protocol/envelope.js";

/**
 * The workspace checkpoint taken before the first write (WP E 波 §6.2).
 *
 * `ports/checkpoint.ts` and `adapters/checkpoint/**` have been in place for a
 * while without anything calling them, which means undo existed as a capability
 * and not as a fact. This module is the missing call — and it is deliberately
 * the *only* call: one snapshot per turn, taken before the first tool that can
 * change the workspace, because a snapshot per tool call would be a copy of the
 * tree per keystroke and a snapshot after the write would be a picture of the
 * damage.
 *
 * Cline's private git ref transaction is the idea being copied, minus the git:
 * the snapshot is a directory copy outside the workspace, so it can never
 * contain itself and it never rewrites history.
 *
 * Failing to snapshot is **reported, not fatal**. Refusing to run a write the
 * user approved because undo storage is unavailable would be a second, worse
 * decision made in the dark; the observation carries the code so the run is
 * visibly unprotected instead of silently unprotected.
 */

export type CheckpointWiring = {
  readonly port: CheckpointPort;
  /**
   * Stated by the host, not inferred: the store refuses a snapshot whose root
   * does not match, and a guessed root would turn "this tree was never
   * snapshotted" into a restore that silently emptied something else.
   */
  readonly workspaceRoot: string;
  readonly now: () => string;
  readonly signal?: AbortSignal;
};

/** Per-turn state: one snapshot, whatever happens afterwards. */
export type CheckpointGateState = {
  preparation:
    | { readonly phase: "unprepared" }
    | { readonly phase: "preparing" | "settled"; readonly completion: Promise<void> };
};

export type CheckpointGate = CheckpointWiring & {
  readonly report: (payload: JsonObject) => void;
  readonly state: CheckpointGateState;
};

/**
 * A fresh per-turn state.
 *
 * Deliberately a factory and not a shared constant: preparation belongs to
 * this turn, so a module-level object would be spent by the first turn of the
 * process and every later turn would silently run with no undo.
 */
export function checkpointState(): CheckpointGateState {
  return { preparation: { phase: "unprepared" } };
}

export function snapshotBeforeWrite(gate: CheckpointGate, toolName: string): Promise<void> {
  const preparation = gate.state.preparation;
  if (preparation.phase !== "unprepared") return preparation.completion;

  // Publish ownership before invoking the adapter. Every writer waits for the
  // same completion, including cancellation/rejection; a failed turn never retries.
  const completion: Promise<void> = Promise.resolve()
    .then(() => snapshotAndReport(gate, toolName))
    .finally(() => {
      gate.state.preparation = { phase: "settled", completion };
    });
  gate.state.preparation = { phase: "preparing", completion };
  return completion;
}

async function snapshotAndReport(gate: CheckpointGate, toolName: string): Promise<void> {
  const result = await snapshotResult(gate, toolName);
  if (!result.ok && result.code === "snapshot_cancelled") {
    gate.report({ component: "checkpoint", status: "cancelled", tool: toolName });
    return;
  }
  if (!result.ok) {
    gate.report({
      component: "checkpoint",
      status: "failed",
      code: result.code,
      tool: toolName,
    });
    return;
  }

  gate.report({
    component: "checkpoint",
    status: "ok",
    checkpointId: result.value.checkpointId,
    files: result.value.manifest.fileCount,
    bytes: result.value.manifest.totalBytes,
    tool: toolName,
  });
}

async function snapshotResult(
  gate: CheckpointGate,
  toolName: string,
): Promise<CheckpointResult<SnapshotOutcome>> {
  try {
    return await gate.port.snapshot({
      workspaceRoot: gate.workspaceRoot,
      label: `before:${toolName}`,
      createdAt: gate.now(),
      ...(gate.signal === undefined ? {} : { signal: gate.signal }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;

    // Undo storage is optional; a rejected snapshot grants no tool permission
    // and cannot revoke an already approved write. Keep private paths out of events.
    return { ok: false, code: "snapshot_interrupted", detail: "checkpoint adapter threw" };
  }
}
