import type { CentralRuntimeDriver } from "./contracts.js";
import { markCentralRuntimeFailure, type CentralRuntimeFailureStage } from "./failure-contract.js";

export type InitializedCentralRuntimeDriver = {
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly driver: CentralRuntimeDriver;
};

export type DeferredCentralRuntimeDriverOptions = {
  readonly readyGate: Promise<void>;
  readonly initialize: (signal: AbortSignal) => Promise<InitializedCentralRuntimeDriver | undefined>;
  readonly persist: (configuration: Readonly<Record<string, unknown>>) => { readonly ok: true } | { readonly ok: false; readonly reason: string };
};

/** The mechanical owner becomes reachable before semantic imports. Initialization
 * owns no inference: its real root metadata must persist before the first drive. */
export function createDeferredCentralRuntimeDriver(options: DeferredCentralRuntimeDriverOptions): CentralRuntimeDriver {
  const lifetime = new AbortController();
  let initialization: Promise<InitializedCentralRuntimeDriver | undefined> | undefined;
  let resource: InitializedCentralRuntimeDriver | undefined, closing: Promise<void> | undefined, resourceClosing: Promise<void> | undefined;
  const active = (signal: AbortSignal) => !signal.aborted && !lifetime.signal.aborted;
  const closeResource = () => resourceClosing ??= Promise.resolve().then(() => resource?.driver.close?.());

  return {
    async drive(input) {
      if (!active(input.signal)) return { state: "ended", reason: "runtime_initialization_cancelled" };

      initialization ??= (async () => {
        let stage: CentralRuntimeFailureStage = "initialization";
        try {
          input.publish({ phase: "initializing", message: "central_runtime_initializing", sourceRefs: [] });
          const signal = AbortSignal.any([input.signal, lifetime.signal]);
          if (!await waitForReady(options.readyGate, signal) || !active(signal)) return undefined;

          resource = await options.initialize(signal);

          if (resource === undefined) {
            if (!active(signal)) return undefined;
            throw new Error("runtime_initialization_unavailable");
          }

          // Construction may have opened the original root before stop arrived.
          // Preserve that real identity even while cancelling, without enabling work.
          stage = "metadata";
          const saved = options.persist(resource.configuration);
          if (!saved.ok) throw new Error(saved.reason);

          if (!active(signal)) return undefined;

          input.publish({ message: "central_runtime_initialized", sourceRefs: [] });

          return resource;
        } catch (error) {
          const original = markCentralRuntimeFailure(error, stage);
          try { await closeResource(); }
          catch (cleanup) { throw markCentralRuntimeFailure(new AggregateError([error, cleanup], "runtime_initialization_cleanup_failed"), stage, original); }
          throw original;
        }
      })();
      const prepared = await initialization;
      if (prepared === undefined || !active(input.signal)) return { state: "ended", reason: "runtime_initialization_cancelled" };

      return prepared.driver.drive({ ...input, configuration: prepared.configuration });
    },
    close() {
      lifetime.abort("central_runtime_scope_closed");
      return closing ??= (async () => {
        try { await initialization; }
        catch { /* Initialization failure belongs to the owning drive; any returned resource still needs cleanup. */ }
        await closeResource();
      })();
    },
  };
}

async function waitForReady(gate: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;

  let abort!: () => void;
  const cancelled = new Promise<boolean>(resolve => {
    abort = () => resolve(false);
    signal.addEventListener("abort", abort, { once: true });
  });

  try { return await Promise.race([gate.then(() => true), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
