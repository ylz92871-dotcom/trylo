import type { CentralRuntimeDriver, CentralRuntimeProgress, CentralRuntimeReply, CentralRuntimeScope,
  CentralRuntimeSnapshot, CentralRuntimeWake } from "./contracts.js";
import { isRuntimeConfiguration, isRuntimeProgress, isRuntimeWake, isRuntimeWakeRequestId, MAX_RUNTIME_SOURCE_WORKSPACE_ROOTS,
  runtimeSourceWorkspaceRootsMatchScope } from "./contracts.js";
import type { RuntimeIntent } from "./files.js";
import { canonicalRuntimeRoot, runtimePathIdentity } from "./files-contract.js";
import { centralRuntimeFailure, type CentralRuntimeFailure } from "./failure-contract.js";
import { pendingRuntimeWake } from "./startup-wake.js";

export type RuntimeIntentWriter = {
  owns(): boolean;
  writeIntent(value: unknown): { readonly ok: true } | { readonly ok: false; readonly reason: string };
};

export type CentralRuntimeCloseRequest = {
  readonly receipt: CentralRuntimeReply;
  readonly closed: Promise<void>;
};

/** One live scope owner. Its only queue is a durable coalesced wake cursor, never a second learning job ledger. */
export function createCentralScopeOwner(options: { readonly scope: CentralRuntimeScope; readonly ownerId: string;
  readonly intent: RuntimeIntent; readonly store: RuntimeIntentWriter; readonly driver: CentralRuntimeDriver;
  readonly now?: () => number; readonly schedule?: (run: () => void, milliseconds: number) => () => void }) {
  let intent = options.intent, revision = 0;
  let state: CentralRuntimeSnapshot["state"] = "waiting", reason: string | undefined;
  let progress: CentralRuntimeProgress | undefined, active: Promise<void> | undefined;
  let failure: CentralRuntimeFailure | undefined;
  let wakeReceipt: { readonly requestId: string; readonly sequence: number } | undefined;
  let closing: Promise<void> | undefined;
  let cancelTimer: (() => void) | undefined;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, milliseconds) => {
    const timer = setTimeout(run, milliseconds);
    return () => clearTimeout(timer);
  });
  const cancel = new AbortController(), listeners = new Set<() => void>();
  const persistedWake = (): CentralRuntimeWake => ({ reason: intent.wakeReason, sourceRefs: intent.sourceRefs,
    ...(intent.sourceWorkspaceRoots === undefined ? {} : { sourceWorkspaceRoots: intent.sourceWorkspaceRoots }) });
  const snapshot = (): CentralRuntimeSnapshot => ({ schemaVersion: 1, scopeKey: options.scope.scopeKey,
    ownerId: options.ownerId, revision, state, wakeSequence: intent.wakeSequence, consumedSequence: intent.consumedSequence,
    paused: intent.recoveryPolicy === "paused",
    ...(intent.recoveryPolicy === undefined ? {} : { recoveryPolicy: intent.recoveryPolicy }),
    ...(reason === undefined ? {} : { reason }), ...(progress === undefined ? {} : { progress }),
    ...(state !== "failed" || failure === undefined ? {} : { failure }) });
  const changed = () => {
    revision++;
    for (const listener of [...listeners]) listener();
  };
  const failed = (code: string, detail = centralRuntimeFailure(new Error(code), "persistence")) => {
    state = "failed";
    reason = code;
    failure = detail;
    progress = undefined;
    changed();
  };
  const arm = (at: number, sourceRefs: readonly string[]) => {
    cancelTimer?.();
    cancelTimer = schedule(() => {
      cancelTimer = undefined;
      if (cancel.signal.aborted) return;
      if (now() < at) arm(at, sourceRefs);
      else wake({ reason: "central_wait_until_due", sourceRefs });
    }, Math.min(0x7fffffff, Math.max(0, at - now())));
  };
  const save = (next: RuntimeIntent): boolean => {
    if (!options.store.owns()) {
      failed("runtime_owner_lost");
      return false;
    }
    const saved = options.store.writeIntent(next);
    if (!saved.ok) {
      failed(saved.reason);
      return false;
    }
    intent = next;
    return true;
  };
  const drain = async () => {
    while (!cancel.signal.aborted && intent.enabled && intent.consumedSequence < intent.wakeSequence) {
      const claimed = intent.wakeSequence, wakeInput = persistedWake();

      cancelTimer?.();
      cancelTimer = undefined;
      state = "running";
      reason = undefined;
      failure = undefined;
      changed();

      try {
        const result = await options.driver.drive({ scope: options.scope, configuration: intent.configuration, wake: wakeInput,
          signal: cancel.signal, publish(value) {
            if (!cancel.signal.aborted && state !== "failed" && isRuntimeProgress(value)) {
              progress = structuredClone(value);
              changed();
              if (value.state === "ready") wake({ reason: value.message.slice(0, 256), sourceRefs: value.sourceRefs });
              else if (value.state === "waiting" && value.wakeAt !== undefined) arm(value.wakeAt, value.sourceRefs);
            }
          } });

        if (cancel.signal.aborted) return;

        if (!save({ ...intent, consumedSequence: claimed })) return;

        state = "waiting";
        reason = result.reason;
        changed();

        if (result.state === "waiting" && result.wakeAt !== undefined) arm(result.wakeAt, result.sourceRefs ?? []);

        if (result.state === "ready" && intent.wakeSequence === claimed && !save({ ...intent, wakeSequence: intent.wakeSequence + 1,
          wakeReason: "driver_continuation", sourceRefs: [] })) return;
      } catch (error) {
        // Keep the unconsumed durable wake for restart or a later explicit wake; do not spin/retry paid work.
        if (!cancel.signal.aborted) failed("runtime_drive_failed", centralRuntimeFailure(error, "drive"));
        return;
      }
    }
  };
  const start = () => {
    if (active !== undefined || cancel.signal.aborted || state === "failed") return;
    active = Promise.resolve().then(drain).finally(() => {
      active = undefined;
      if (intent.consumedSequence < intent.wakeSequence && state !== "failed") start();
    });
  };
  const wake = (input: CentralRuntimeWake, configuration?: Readonly<Record<string, unknown>>): CentralRuntimeReply => {
    if (!isRuntimeWake(input)) return { ok: false, reason: "runtime_wake_invalid" };

    if (configuration !== undefined) return { ok: false, reason: "runtime_configuration_handoff_required" };

    if (!intent.enabled) return { ok: false, reason: "runtime_disabled" };

    if (cancel.signal.aborted) return { ok: false, reason: "runtime_stopping" };

    const roots = intent.sourceWorkspaceRoots === undefined && input.sourceWorkspaceRoots === undefined ? undefined
      : [...new Set([...(intent.sourceWorkspaceRoots ?? []), ...(input.sourceWorkspaceRoots ?? [])])];
    if (roots !== undefined) {
      if (!runtimeSourceWorkspaceRootsMatchScope(roots, options.scope.workspaceRoot)) return { ok: false, reason: "runtime_scope_mismatch" };
      if (roots.length > MAX_RUNTIME_SOURCE_WORKSPACE_ROOTS) return { ok: false, reason: "runtime_source_workspace_roots_capacity" };
    }

    // Coalescing scheduling reasons must retain every accepted source in the
    // unconsumed batch. Consumed batches do not accumulate into later work.
    const sourceRefs = [...new Set([...(intent.consumedSequence < intent.wakeSequence ? intent.sourceRefs : []), ...input.sourceRefs])];
    if (!isRuntimeWake({ ...input, sourceRefs })) return { ok: false, reason: "runtime_wake_source_refs_capacity" };

    if (!save({ ...intent,
      wakeSequence: intent.wakeSequence + 1, wakeReason: input.reason, sourceRefs,
      ...(roots === undefined ? {} : { sourceWorkspaceRoots: roots }) })) {
      return { ok: false, reason: reason ?? "runtime_write_failed" };
    }

    if (state === "failed") {
      state = "waiting";
      failure = undefined;
    }

    changed();
    start();
    return { ok: true, snapshot: snapshot() };
  };
  const requestClose = (mode: "stop" | "pause" | "restart" = "restart"): CentralRuntimeCloseRequest => {
    // Latest stop authority must persist even after a privacy pause started the
    // single drain. Persistence acceptance and drain completion are distinct.
    const persisted = mode === "stop" ? !intent.enabled || save({ ...intent, enabled: false })
      : mode !== "pause" || intent.recoveryPolicy === "paused" || save({ ...intent, recoveryPolicy: "paused" });
    const refusal = persisted ? undefined : reason ?? "runtime_write_failed";
    const closed = closing ??= (async () => {
      cancelTimer?.();
      cancelTimer = undefined;
      state = "stopping";
      cancel.abort();
      changed();
      await active;
      await options.driver.close?.();
      state = "stopped";
      changed();
    })();

    return { receipt: refusal === undefined ? { ok: true, snapshot: snapshot() } : { ok: false, reason: refusal }, closed };
  };

  return {
    snapshot, requestClose,
    /** An explicit ordinary entry changes recovery eligibility, not stop authority or the wake cursor. */
    activate(): CentralRuntimeReply {
      if (!intent.enabled) return { ok: false, reason: "runtime_disabled" };
      if (cancel.signal.aborted) return { ok: false, reason: "runtime_stopping" };
      if (intent.recoveryPolicy !== "eligible" && !save({ ...intent, recoveryPolicy: "eligible" })) {
        return { ok: false, reason: reason ?? "runtime_write_failed" };
      }
      changed();
      return { ok: true, snapshot: snapshot() };
    },
    wake(input: CentralRuntimeWake, configuration?: Readonly<Record<string, unknown>>, requestId?: string): CentralRuntimeReply {
      if (requestId !== undefined && !isRuntimeWakeRequestId(requestId)) return { ok: false, reason: "runtime_wake_request_invalid" };
      const receipt = wake(input, configuration);
      // Only a successful original intent publication proves acceptance. A later
      // external request replaces this one slot; internal ready/timer wakes do not.
      if (receipt.ok) wakeReceipt = requestId === undefined ? undefined : { requestId, sequence: receipt.snapshot.wakeSequence };
      return receipt;
    },
    wakeReceipt(requestId: string): CentralRuntimeReply {
      if (!options.store.owns()) return { ok: false, reason: "runtime_owner_lost" };
      if (!isRuntimeWakeRequestId(requestId) || wakeReceipt?.requestId !== requestId || wakeReceipt.sequence > intent.wakeSequence) {
        return { ok: false, reason: "runtime_wake_receipt_unknown" };
      }
      return { ok: true, snapshot: snapshot() };
    },
    /** Internal startup metadata only. Public wake cannot reconfigure a live composition. */
    updateConfiguration(configuration: Readonly<Record<string, unknown>>, expectedConfiguration: Readonly<Record<string, unknown>>,
      verifiedWorkspaceRoot?: string): CentralRuntimeReply {
      if (state === "stopped") return { ok: false, reason: "runtime_stopping" };

      if (!isRuntimeConfiguration(configuration) || !isRuntimeConfiguration(expectedConfiguration)) return { ok: false, reason: "runtime_configuration_invalid" };

      if (JSON.stringify(intent.configuration) !== JSON.stringify(expectedConfiguration)) return { ok: false, reason: "runtime_configuration_changed" };

      if (verifiedWorkspaceRoot !== undefined) {
        try {
          if (canonicalRuntimeRoot(verifiedWorkspaceRoot) !== verifiedWorkspaceRoot
            || runtimePathIdentity(verifiedWorkspaceRoot) !== runtimePathIdentity(canonicalRuntimeRoot(options.scope.workspaceRoot))) {
            return { ok: false, reason: "runtime_scope_mismatch" };
          }
        } catch { return { ok: false, reason: "runtime_scope_mismatch" }; }
      }

      if (!save({ ...intent, configuration, ...(verifiedWorkspaceRoot === undefined ? {} : { workspaceRoot: verifiedWorkspaceRoot }) })) {
        return { ok: false, reason: reason ?? "runtime_write_failed" };
      }

      changed();
      return { ok: true, snapshot: snapshot() };
    },
    start() {
      if (!intent.enabled || intent.recoveryPolicy === "paused") return;
      if (pendingRuntimeWake(intent) !== undefined) start();
      else wake({ ...persistedWake(), reason: "owner_recovery" });
    },
    wait(afterRevision: number, signal: AbortSignal): Promise<CentralRuntimeSnapshot> {
      if (revision > afterRevision || cancel.signal.aborted || signal.aborted) return Promise.resolve(snapshot());
      return new Promise(resolve => {
        const finish = () => {
          listeners.delete(finish);
          signal.removeEventListener("abort", finish);
          resolve(snapshot());
        };
        listeners.add(finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    },
    async close(mode: "stop" | "pause" | "restart" = "restart"): Promise<void> {
      const requested = requestClose(mode);
      await requested.closed;
      if (!requested.receipt.ok) throw new Error(requested.receipt.reason);
    },
  };
}

export type CentralScopeOwner = ReturnType<typeof createCentralScopeOwner>;
