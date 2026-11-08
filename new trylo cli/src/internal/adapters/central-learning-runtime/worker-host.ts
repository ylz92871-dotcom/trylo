import type { MessagePort } from "node:worker_threads";
import type { CentralRuntimeScope } from "./contracts.js";
import type { InitializedCentralRuntimeDriver } from "./deferred-driver.js";
import { isCentralRuntimeWorkerRequest, type CentralRuntimeWorkerReply } from "./worker-protocol.js";
import { centralRuntimeFailure } from "./failure-contract.js";

export type InitializedCentralRuntimeWorker = InitializedCentralRuntimeDriver & {
  readonly basisConfiguration: Readonly<Record<string, unknown>>; readonly workspaceRoot: string; readonly budgetScope: string;
};

/** Private same-process carrier only. The initialized original host remains the
 * sole semantic/Board/credential owner; this port never chooses or funds work. */
export function serveCentralRuntimeWorker(options: { readonly port: MessagePort; readonly stop: Int32Array;
  readonly scope: CentralRuntimeScope; readonly initialize: (signal: AbortSignal) => Promise<InitializedCentralRuntimeWorker | undefined> }) {
  const cancel = new AbortController();
  let resource: InitializedCentralRuntimeWorker | undefined, active: Promise<void> | undefined, closing: Promise<void> | undefined;
  let metadataCommitted = false, portClosed = false;
  const stopped = () => Atomics.load(options.stop, 0) !== 0 || cancel.signal.aborted;
  const stop = () => {
    Atomics.store(options.stop, 0, 1);
    cancel.abort("central_runtime_scope_closed");
  };
  const send = (value: CentralRuntimeWorkerReply) => { if (!portClosed) options.port.postMessage(value); };
  const close = () => {
    stop();
    return closing ??= (async () => {
      try {
        try { await initialization; }
        catch { /* Initialization failure was sent separately; clean any returned original resource. */ }
        await active;
        await resource?.driver.close?.();
        send({ operation: "closed", ok: true });
      } catch {
        send({ operation: "closed", ok: false, reason: "runtime_worker_close_failed" });
      } finally { options.port.close(); }
    })();
  };

  options.port.on("close", () => {
    portClosed = true;
    void close();
  });
  // Install the stop listener before initialization begins its heavy imports.
  // The shared stop bit also fences code while this thread cannot dispatch messages.
  options.port.on("message", (raw: unknown) => {
    if (!isCentralRuntimeWorkerRequest(raw)) {
      stop();
      void close();
      return;
    }

    if (raw.operation === "stop") {
      stop();
      return;
    }

    if (raw.operation === "close") {
      void close();
      return;
    }

    if (raw.operation === "metadata_committed") {
      metadataCommitted = true;
      return;
    }

    if (raw.operation !== "drive") return;

    if (!metadataCommitted || resource === undefined) {
      send({ operation: "drive_failed", requestId: raw.requestId, reason: "runtime_worker_metadata_uncommitted" });
      return;
    }

    if (stopped()) {
      send({ operation: "result", requestId: raw.requestId, result: { state: "ended", reason: "runtime_worker_cancelled" } });
      return;
    }

    if (raw.scope.scopeKey !== options.scope.scopeKey || raw.scope.homeRoot !== options.scope.homeRoot
      || raw.scope.workspaceRoot !== options.scope.workspaceRoot) {
      send({ operation: "drive_failed", requestId: raw.requestId, reason: "runtime_worker_scope_mismatch" });
      return;
    }

    if (active !== undefined) {
      send({ operation: "drive_failed", requestId: raw.requestId, reason: "runtime_worker_busy" });
      return;
    }

    const current = resource;

    active = (async () => {
      try {
        const result = await current.driver.drive({ scope: { ...raw.scope, workspaceRoot: current.budgetScope },
          configuration: current.configuration, wake: raw.wake,
          signal: cancel.signal, publish: progress => {
            if (!stopped()) send({ operation: "progress", scopeKey: options.scope.scopeKey, progress });
          } });
        send({ operation: "result", requestId: raw.requestId, result });
      } catch (error) { send({ operation: "drive_failed", requestId: raw.requestId, reason: "runtime_worker_drive_failed",
        failure: centralRuntimeFailure(error, "drive") }); }
      finally { active = undefined; }
    })();
  });
  const initialization = Promise.resolve().then(async () => {
    if (stopped()) return undefined;
    resource = await options.initialize(cancel.signal);
    return resource;
  });

  void initialization.then(value => {
    if (value === undefined) {
      send({ operation: "initialization_cancelled" });
      void close();
    }
    else send({ operation: "initialized", configuration: value.configuration, basisConfiguration: value.basisConfiguration,
      workspaceRoot: value.workspaceRoot });
  }, error => { send({ operation: "initialization_failed", reason: "runtime_worker_initialization_failed",
    failure: centralRuntimeFailure(error, "initialization") });
  void close(); });
}
