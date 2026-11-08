import { createInterface } from "node:readline";
import { serveCentralRuntime } from "../../internal/adapters/central-learning-runtime/server.js";
import { createDeferredCentralRuntimeDriver } from "../../internal/adapters/central-learning-runtime/deferred-driver.js";
import { initializeCentralRuntimeWorker, type CentralRuntimeWorkerDriver } from "../../internal/adapters/central-learning-runtime/worker-driver.js";
import { runtimeRecord } from "../../internal/adapters/central-learning-runtime/contracts.js";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../internal/adapters/central-learning-runtime/files.js";
import { isCentralRuntimeConfiguration } from "../../internal/surface/cli/central-runtime-configuration.js";
import { pendingRuntimeWake } from "../../internal/adapters/central-learning-runtime/startup-wake.js";
import { isCentralRuntimeActivation, isRuntimeActivationFailure, runtimeActivationFailure } from "../../internal/adapters/central-learning-runtime/launch.js";
import { isCentralRuntimeWorkspaceLocation, runtimeWorkspaceLocationMatches } from "../../internal/adapters/central-learning-runtime/workspace-location.js";

/** Managed child entry. Only non-secret configuration references cross the startup pipe. */
async function start() {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const line = await new Promise<string | undefined>(resolve => {
    reader.once("line", value => {
      resolve(value);
      reader.close();
    });
    reader.once("close", () => resolve(undefined));
  });
  if (line === undefined || Buffer.byteLength(line) > 65536) throw new Error("runtime_bootstrap_invalid");

  const input: unknown = JSON.parse(line);
  if (!runtimeRecord(input) || input.schemaVersion !== 1 || typeof input.homeRoot !== "string" || typeof input.workspaceRoot !== "string") {
    throw new Error("runtime_bootstrap_invalid");
  }

  if (!isCentralRuntimeConfiguration(input.configuration)) throw new Error("runtime_configuration_invalid");

  const location = input.workspaceLocation;
  if (location !== undefined && (!isCentralRuntimeWorkspaceLocation(location)
    || !runtimeWorkspaceLocationMatches(location, input.workspaceRoot, input.configuration))) throw new Error("runtime_bootstrap_invalid");

  if (input.activation !== undefined && !isCentralRuntimeActivation(input.activation)) throw new Error("runtime_bootstrap_invalid");

  const paths = runtimeScopePaths(input.homeRoot, input.workspaceRoot), acquired = tryAcquireRuntimeOwner(paths);
  if (!acquired.ok) throw new Error(acquired.reason);

  const owner = acquired.value, previous = readRuntimeIntent(paths);
  if (!previous.ok) {
    owner.close();
    throw new Error(previous.reason);
  }

  const activationFailure = runtimeActivationFailure(input.activation, previous.value, "launch");
  if (activationFailure !== undefined) {
    owner.close();
    throw new Error(activationFailure);
  }

  const configuration = previous.value?.configuration ?? input.configuration;
  if (!isCentralRuntimeConfiguration(configuration)) {
    owner.close();
    throw new Error("runtime_configuration_invalid");
  }

  const saved = owner.writeIntent({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: previous.value?.workspaceRoot ?? paths.workspaceRoot,
    configuration, enabled: true, wakeSequence: previous.value?.wakeSequence ?? 0,
    consumedSequence: previous.value?.consumedSequence ?? 0,
    ...(pendingRuntimeWake(previous.value) ?? { wakeReason: "owner_bootstrap", sourceRefs: [] }),
    ...(input.activation === "ordinary" ? { recoveryPolicy: "eligible" }
      : previous.value?.recoveryPolicy === undefined ? {} : { recoveryPolicy: previous.value.recoveryPolicy }),
    ...(previous.value?.sourceWorkspaceRoots === undefined ? {} : { sourceWorkspaceRoots: previous.value.sourceWorkspaceRoots }) });
  if (!saved.ok) {
    owner.close();
    throw new Error(saved.reason);
  }

  let releaseReady!: () => void;
  const readyGate = new Promise<void>(resolve => { releaseReady = resolve; });
  let server: Awaited<ReturnType<typeof serveCentralRuntime>> | undefined;
  let carrier: CentralRuntimeWorkerDriver | undefined;
  const driver = createDeferredCentralRuntimeDriver({ readyGate,

    async initialize(signal) {
      carrier = await initializeCentralRuntimeWorker({ homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
        configuration, ...(location === undefined ? {} : { workspaceLocation: location }),
        diagnostic: text => { process.stderr.write(text); } }, signal);
      return carrier;
    },

    persist: value => {
      if (server === undefined || carrier === undefined) return { ok: false, reason: "runtime_owner_not_bound" };
      const saved = server.owner.updateConfiguration(value, carrier.basisConfiguration, carrier.workspaceRoot);
      if (saved.ok) carrier.acknowledgeMetadata();
      return saved;
    },
  });

  try {
    server = await serveCentralRuntime({ paths, owner, configuration, driver });
    const close = () => { void server!.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(server!.address)}\n`, error => error ? reject(error) : resolve()));
    releaseReady();
  } catch (error) {
    try { if (server === undefined) await driver.close?.();else await server.close(); }
    finally { owner.close(); }
    throw error;
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/cmd/trylo/central-runtime-main.js")) {
  try { await start(); }
  catch (error) {
    if (error instanceof Error && isRuntimeActivationFailure(error.message)) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: error.message })}\n`);
    }
    process.stderr.write("central runtime startup failed; original learning intent was retained\n");
    process.exitCode = 1;
  }
}
