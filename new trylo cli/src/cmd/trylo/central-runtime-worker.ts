import { parentPort, workerData } from "node:worker_threads";
import { isCentralRuntimeWorkerBootstrap } from "../../internal/adapters/central-learning-runtime/worker-protocol.js";
import { serveCentralRuntimeWorker } from "../../internal/adapters/central-learning-runtime/worker-host.js";
import { readRuntimeIntent, runtimeScopePaths } from "../../internal/adapters/central-learning-runtime/files.js";
import { isCentralRuntimeConfiguration } from "../../internal/surface/cli/central-runtime-configuration.js";
import { centralRuntimeExecutionContext } from "../../internal/surface/cli/central-runtime-execution-context.js";

if (parentPort === null || !isCentralRuntimeWorkerBootstrap(workerData)) throw new Error("runtime_worker_bootstrap_invalid");

const paths = runtimeScopePaths(workerData.homeRoot, workerData.workspaceRoot), stop = new Int32Array(workerData.stopBuffer);

serveCentralRuntimeWorker({ port: parentPort, stop, scope: paths,

  async initialize(signal) {
    const [{ createProcessContext }, { createCentralRuntimeHost }, { resolveCentralRuntimeWorkspaceIdentity }] = await Promise.all([
      import("./main.js"), import("../../internal/surface/cli/central-runtime-host.js"),
      import("../../internal/surface/cli/central-runtime-workspace-identity.js"),
    ]);

    if (signal.aborted || Atomics.load(stop, 0) !== 0) return undefined;

    const latest = readRuntimeIntent(paths);
    if (!latest.ok) throw new Error(latest.reason);

    if (latest.value?.enabled !== true || latest.value.recoveryPolicy === "paused") return undefined;

    const current = latest.value.configuration;
    if (!isCentralRuntimeConfiguration(current)) throw new Error("runtime_configuration_invalid");

    const owned = createProcessContext();

    try {
      const original = centralRuntimeExecutionContext({ ...owned, cwd: paths.workspaceRoot,
        env: { ...owned.env, TRYLO_HOME: paths.homeRoot }, stdout: owned.stderr }, paths.workspaceRoot, current, workerData.workspaceLocation);
      const resolved = await resolveCentralRuntimeWorkspaceIdentity(original, paths.workspaceRoot, { allowBudgetLookup: true });
      if (!resolved.ok) throw new Error(resolved.reason);

      if (signal.aborted || Atomics.load(stop, 0) !== 0) {
        owned.close();
        return undefined;
      }

      const descriptor = resolved.value, ctx = { ...original, cwd: descriptor.budgetScope, workspaceIdentity: descriptor };
      const configuration = current.rootRef !== undefined || descriptor.rootRef === undefined ? current : { ...current, rootRef: descriptor.rootRef };
      const runtime = await createCentralRuntimeHost(ctx, configuration);

      return { configuration: runtime.configuration, basisConfiguration: current, workspaceRoot: descriptor.workspaceRoot,
        budgetScope: descriptor.budgetScope, driver: {
        drive: input => runtime.driver.drive(input),
        async close() { try { await runtime.driver.close?.(); } finally { owned.close(); } },
      } };
    } catch (error) {
      owned.close();
      throw error;
    }
  },
});
