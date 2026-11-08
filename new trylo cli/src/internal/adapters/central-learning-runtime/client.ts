import { mkdirSync } from "node:fs";
import path from "node:path";
import { releaseLock, tryAcquireLock } from "../learning-store/lock.js";
import { readRuntimeIntent, readRuntimeLocator, runtimeScopePaths, tryAcquireRuntimeOwner,
  type RuntimeLocator, type RuntimeScopePaths } from "./files.js";
import { isRuntimeConfiguration, type CentralRuntimeReply, type CentralRuntimeWake } from "./contracts.js";
import { CentralRuntimeStartupRefusal, isCentralRuntimeActivation, launchCentralRuntime, runtimeActivationFailure,
  type CentralRuntimeBootstrap, type CentralRuntimeLaunch } from "./launch.js";
import { requestCentralRuntime } from "./transport.js";

function clientFor(initialAddress: RuntimeLocator, paths: RuntimeScopePaths) {
  let address = initialAddress;
  let detached = false;
  const request = (input: Parameters<typeof requestCentralRuntime>[1], signal?: AbortSignal): Promise<CentralRuntimeReply> => {
    if (detached) return Promise.resolve({ ok: false, reason: "runtime_client_detached" });

    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "runtime_client_aborted" });

    // A long-lived business turn can outlast a normal owner handoff. Discover
    // only an already-published owner of this exact home/scope before sending
    // a new request. Never launch an owner or retry an uncertain write here.
    const found = readRuntimeLocator(paths);
    if (!found.ok) return Promise.resolve({ ok: false, reason: found.reason });

    const ownerChanged = found.value !== undefined && found.value.ownerId !== address.ownerId;

    if (found.value !== undefined) address = found.value;

    // Revision cursors belong to an owner. On handoff, return its current
    // snapshot rather than wait against the previous owner's numeric cursor.
    return requestCentralRuntime(address, ownerChanged && input.operation === "wait" ? { operation: "status" } : input, signal);
  };

  return { scopeKey: initialAddress.scopeKey, get ownerId() { return address.ownerId; },
    status: (signal?: AbortSignal) => request({ operation: "status" }, signal),
    activate: (signal?: AbortSignal) => request({ operation: "activate" }, signal),
    wait: (afterRevision: number, signal?: AbortSignal) => request({ operation: "wait", afterRevision }, signal),
    wake: (wake: CentralRuntimeWake, configuration?: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
      request({ operation: "wake", wake, ...(configuration === undefined ? {} : { configuration }) }, signal),
    stop: (signal?: AbortSignal) => request({ operation: "stop" }, signal),
    pause: (signal?: AbortSignal) => request({ operation: "stop", mode: "pause" }, signal),
    detach: () => { detached = true; },
  };
}

export type CentralRuntimeClient = ReturnType<typeof clientFor>;

export type CentralRuntimeAttachment = { readonly ok: true; readonly client: CentralRuntimeClient; readonly initial: CentralRuntimeReply;
  /** Only this call's acknowledged child launch supplies a startup recovery receipt. */
  readonly ownerSource: "launched" | "existing" }
  | { readonly ok: false; readonly reason: string };

/** CLI and Desktop borrow one scope owner; a turn ending only detaches its client. */
export async function attachCentralRuntime(input: Omit<CentralRuntimeBootstrap, "schemaVersion">, launch: CentralRuntimeLaunch,
  options: { readonly signal?: AbortSignal; readonly sleep?: (milliseconds: number) => Promise<void> } = {}): Promise<CentralRuntimeAttachment> {
  if (!isRuntimeConfiguration(input.configuration)) return { ok: false, reason: "runtime_configuration_invalid" };

  if (input.activation !== undefined && !isCentralRuntimeActivation(input.activation)) return { ok: false, reason: "runtime_bootstrap_invalid" };

  const paths = runtimeScopePaths(input.homeRoot, input.workspaceRoot);
  const authority = (phase: "existing" | "launch") => {
    const intent = readRuntimeIntent(paths);
    if (!intent.ok) return intent;
    const reason = runtimeActivationFailure(input.activation, intent.value, phase);
    return reason === undefined ? { ok: true as const, intent: intent.value } : { ok: false as const, reason };
  };
  const existing = async (): Promise<CentralRuntimeAttachment | undefined> => {
    if (input.activation !== undefined) {
      const admitted = authority("existing");
      if (!admitted.ok) return admitted;
    }

    const found = readRuntimeLocator(paths);
    if (!found.ok) return { ok: false, reason: found.reason };

    if (found.value === undefined) return undefined;

    const client = clientFor(found.value, paths), status = await client.status(options.signal);
    if (!status.ok) return options.signal?.aborted ? { ok: false, reason: status.reason } : undefined;

    if (status.snapshot.state === "stopping" || status.snapshot.state === "stopped") {
      client.detach();
      return undefined;
    }

    if (input.activation !== undefined) {
      const admitted = authority("existing");
      if (!admitted.ok) {
        client.detach();
        return admitted;
      }
    }

    const initial = input.activation === "ordinary" ? await client.activate(options.signal) : status;
    if (!initial.ok) {
      client.detach();
      return initial;
    }

    return { ok: true, client, initial, ownerSource: "existing" };
  };

  try {
    const ready = await existing();
    if (ready !== undefined) return ready;

    mkdirSync(paths.directory, { recursive: true });
    const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));

    // This lease covers startup only. The child independently holds owner.lock for its entire lifetime.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (options.signal?.aborted) return { ok: false, reason: "runtime_client_aborted" };

      const lock = tryAcquireLock(path.join(paths.directory, "startup.lock"));
      if ("ok" in lock) {
        await sleep(100);
        const joined = await existing();
        if (joined !== undefined) return joined;
        continue;
      }

      try {
        const joined = await existing();
        if (joined !== undefined) return joined;

        const admitted = authority("launch");
        if (!admitted.ok) return admitted;

        // An acknowledged pause may still be draining its worker. Do not
        // attach a stopping owner or launch a competing child into its lease.
        const probe = tryAcquireRuntimeOwner(paths);
        if (!probe.ok) {
          if (probe.reason !== "runtime_owner_busy") return probe;
          await sleep(100);
          continue;
        }

        probe.value.close();
        const address = await launchCentralRuntime(launch, { schemaVersion: 1, homeRoot: paths.homeRoot,
          workspaceRoot: paths.workspaceRoot, configuration: admitted.intent?.configuration ?? input.configuration,
          ...(input.activation === undefined ? {} : { activation: input.activation }) }, paths.scopeKey);
        const client = clientFor(address, paths), initial = await client.status(options.signal);

        return initial.ok ? { ok: true, client, initial, ownerSource: "launched" } : { ok: false, reason: initial.reason };
      } finally { releaseLock(lock); }
    }

    return { ok: false, reason: "runtime_start_busy" };
  } catch (error) {
    return { ok: false, reason: error instanceof CentralRuntimeStartupRefusal ? error.reason : "runtime_attach_failed" };
  }
}
