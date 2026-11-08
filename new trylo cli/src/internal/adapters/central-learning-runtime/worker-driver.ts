import { Worker } from "node:worker_threads";
import type { CentralRuntimeDriver } from "./contracts.js";
import type { InitializedCentralRuntimeDriver } from "./deferred-driver.js";
import { runtimeScopePaths } from "./files.js";
import { runtimeRecord, runtimeRefs } from "./contracts.js";
import { isCentralRuntimeWorkerReply, type CentralRuntimeWorkerBootstrap, type CentralRuntimeWorkerRequest,
  type CentralRuntimeWorkerResult } from "./worker-protocol.js";
import { centralRuntimeFailure, centralRuntimeFailureError, markCentralRuntimeFailure } from "./failure-contract.js";
import type { CentralRuntimeWorkspaceLocation } from "./workspace-location.js";

export type CentralRuntimeWorkerDriver = InitializedCentralRuntimeDriver & {
  readonly basisConfiguration: Readonly<Record<string, unknown>>;
  readonly workspaceRoot: string;
  acknowledgeMetadata(): void;
};

/** Control/intent stay on the parent event loop. No production terminate: close
 * waits for the original driver's cancellation, accounting and resource drain. */
export async function initializeCentralRuntimeWorker(options: {
  readonly homeRoot: string; readonly workspaceRoot: string; readonly configuration: Readonly<Record<string, unknown>>;
  readonly diagnostic: (text: string) => void; readonly entrypoint?: URL;
  readonly workspaceLocation?: CentralRuntimeWorkspaceLocation;
}, signal: AbortSignal): Promise<CentralRuntimeWorkerDriver | undefined> {
  if (signal.aborted) return undefined;

  // The shared stop flag remains visible while the worker is busy with inference.
  const stopBuffer = new SharedArrayBuffer(4), stop = new Int32Array(stopBuffer);
  const workerData: CentralRuntimeWorkerBootstrap = { schemaVersion: 1, homeRoot: options.homeRoot,
    workspaceRoot: options.workspaceRoot, configuration: options.configuration, stopBuffer,
    ...(options.workspaceLocation === undefined ? {} : { workspaceLocation: options.workspaceLocation }) };
  const worker = new Worker(options.entrypoint ?? new URL("../../../cmd/trylo/central-runtime-worker.js", import.meta.url),
    { workerData, stdout: true, stderr: true });
  let alive = true, committed = false, sequence = 0, closedReceipt: { readonly ok: boolean; readonly reason?: string } | undefined;
  type Pending = { readonly requestId: string;
    readonly resolve: (value: CentralRuntimeWorkerResult) => void; readonly reject: (error: Error) => void };
  let pending: Pending | undefined;
  let terminalFailure: Error | undefined;
  const scopeKey = runtimeScopePaths(options.homeRoot, options.workspaceRoot).scopeKey;
  let publish: Parameters<CentralRuntimeDriver["drive"]>[0]["publish"] | undefined;
  let publishSignal: AbortSignal | undefined;
  let initialized!: (value: { readonly configuration: Readonly<Record<string, unknown>>;
    readonly basisConfiguration: Readonly<Record<string, unknown>>; readonly workspaceRoot: string } | undefined) => void;
  let initializationFailed!: (error: Error) => void;
  const initialization = new Promise<Parameters<typeof initialized>[0]>((resolve, reject) => {
    initialized = resolve;
    initializationFailed = reject;
  });
  let exited!: (code: number) => void;
  const exit = new Promise<number>(resolve => { exited = resolve; });
  const send = (value: CentralRuntimeWorkerRequest) => {
    if (!alive) throw new Error("runtime_worker_closed");
    worker.postMessage(value);
  };
  const clearPublisher = () => {
    publish = undefined;
    publishSignal?.removeEventListener("abort", onPublishAbort);
    publishSignal = undefined;
  };
  const abort = () => {
    Atomics.store(stop, 0, 1);
    clearPublisher();
    if (alive) {
      try { send({ operation: "stop" }); }
      catch { failed("runtime_worker_closed"); }
    }
  };
  const onPublishAbort = () => abort();
  const failed = (reason: string) => {
    const error = terminalFailure ??= centralRuntimeFailureError(reason, centralRuntimeFailure(new Error(reason), "transport"), "transport");
    clearPublisher();
    initializationFailed(error);
    pending?.reject(error);
    pending = undefined;
  };
  const diagnostic = (chunk: Buffer) => {
    try { options.diagnostic(chunk.toString("utf8")); }
    catch { /* Diagnostics cannot change original inference or accounting ownership. */ }
  };

  worker.stdout.on("data", diagnostic);
  worker.stderr.on("data", diagnostic);
  worker.on("message", (raw: unknown) => {
    if (!isCentralRuntimeWorkerReply(raw)) {
      const result = runtimeRecord(raw) && runtimeRecord(raw.result) ? raw.result : undefined;
      // Structural counts only, without arbitrary payload or source text.
      try { options.diagnostic(`${JSON.stringify({ event: "runtime_worker_reply_invalid", kind: result === undefined ? "other" : "result",
        refsCount: Array.isArray(result?.sourceRefs) ? result.sourceRefs.length : null,
        refsValid: result?.sourceRefs === undefined || runtimeRefs(result.sourceRefs),
        maxRefChars: Array.isArray(result?.sourceRefs) ? Math.max(0, ...result.sourceRefs.map(ref => typeof ref === "string" ? ref.length : 0)) : null,
        reasonChars: typeof result?.reason === "string" ? result.reason.length : null })}\n`); }
      catch { /* Diagnostics never replace the original rejection. */ }
      failed("runtime_worker_reply_invalid");
      abort();
      send({ operation: "close" });
      return;
    }
    switch (raw.operation) {
      case "initialized":
        initialized({ configuration: raw.configuration, basisConfiguration: raw.basisConfiguration,
          workspaceRoot: raw.workspaceRoot });
        break;

      case "initialization_cancelled":
        initialized(undefined);
        break;

      case "initialization_failed":
        terminalFailure ??= centralRuntimeFailureError(raw.reason, raw.failure, "initialization");
        initializationFailed(terminalFailure);
        break;

      case "closed":
        closedReceipt = raw;
        break;

      case "progress":
        if (raw.scopeKey !== scopeKey) {
          failed("runtime_worker_scope_mismatch");
          abort();
          break;
        }

        if (publish !== undefined && Atomics.load(stop, 0) === 0) {
          try { publish(raw.progress); }
          catch {
            failed("runtime_worker_progress_failed");
            abort();
          }
        }
        break;

      // Only the matching drive may settle the current request.
      case "result":
        if (pending?.requestId === raw.requestId) {
          pending.resolve(raw.result);
          pending = undefined;
        }
        break;

      case "drive_failed":
        if (pending?.requestId === raw.requestId) {
          pending.reject(centralRuntimeFailureError(raw.reason, raw.failure, "drive"));
          pending = undefined;
        }
        break;
    }
  });
  worker.on("error", error => {
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    failed(code === "ERR_WORKER_OUT_OF_MEMORY" ? "runtime_worker_out_of_memory"
      : code === "ERR_MODULE_NOT_FOUND" ? "runtime_worker_module_not_found"
        : code === "EPIPE" ? "runtime_worker_output_closed"
          : error instanceof SyntaxError ? "runtime_worker_syntax_error" : "runtime_worker_failed");
  });
  worker.once("exit", code => {
    alive = false;
    signal.removeEventListener("abort", abort);
    failed("runtime_worker_closed");
    exited(code);
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  try {
    const ready = await initialization;
    if (ready === undefined) {
      await exit;
      return undefined;
    }

    let closing: Promise<void> | undefined;

    return { ...ready,
      acknowledgeMetadata() { if (!committed) {
        send({ operation: "metadata_committed" });
        committed = true;
      } },
      driver: {
        drive(input) {
          if (!committed) return Promise.reject(markCentralRuntimeFailure(new Error("runtime_worker_metadata_uncommitted"), "metadata"));

          if (!alive) return Promise.reject(terminalFailure ?? markCentralRuntimeFailure(new Error("runtime_worker_closed"), "transport"));

          if (pending !== undefined) return Promise.reject(markCentralRuntimeFailure(new Error("runtime_worker_busy"), "transport"));

          if (input.signal.aborted || Atomics.load(stop, 0) !== 0) return Promise.resolve({ state: "ended", reason: "runtime_worker_cancelled" });

          return new Promise((resolve, reject) => {
            const requestId = `drive:${++sequence}`;

            clearPublisher();
            publish = input.publish;
            publishSignal = input.signal;
            publishSignal.addEventListener("abort", onPublishAbort, { once: true });
            pending = { requestId, resolve, reject };

            try { send({ operation: "drive", requestId, scope: { homeRoot: input.scope.homeRoot,
              workspaceRoot: input.scope.workspaceRoot, scopeKey: input.scope.scopeKey }, wake: input.wake }); }
            catch (error) {
              clearPublisher();
              pending = undefined;
              reject(markCentralRuntimeFailure(error, "transport"));
            }
          });
        },
        close() {
          abort();
          return closing ??= (async () => {
            let sent = true;

            if (alive) {
              try { send({ operation: "close" }); }
              catch { sent = false; }
            }

            const code = await exit;
            if (!sent || code !== 0 || closedReceipt?.ok !== true) throw new Error(closedReceipt?.reason ?? "runtime_worker_close_unconfirmed");
          })();
        },
      },
    };
  } catch (error) {
    abort();
    if (alive) {
      try { send({ operation: "close" }); }
      catch { /* The initialization failure is already owned; still await thread exit before releasing its carrier. */ }
    }
    await exit;
    throw error;
  }
}
