import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { isCentralRuntimeWorkerBootstrap } from "./worker-protocol.js";
import { serveCentralRuntimeWorker } from "./worker-host.js";
import { runtimeScopePaths } from "./files.js";

if (!isMainThread) {
  if (parentPort === null || !isCentralRuntimeWorkerBootstrap(workerData)) throw new Error("fixture_bootstrap_invalid");

  const input = workerData, stop = new Int32Array(input.stopBuffer), scope = runtimeScopePaths(input.homeRoot, input.workspaceRoot);
  let calls = 0;

  serveCentralRuntimeWorker({ port: parentPort, scope, stop,
    async initialize() {
      if (typeof input.configuration.fixtureRequestedRoot === "string" && input.workspaceRoot !== input.configuration.fixtureRequestedRoot) {
        throw new Error("fixture_requested_root_lost");
      }

      if (input.configuration.fixtureReject === true) throw new Error("fixture_initialize_rejected");

      if (input.configuration.fixtureFailure === "initialization-known") throw new Error("organization_sensitive_content");

      if (input.configuration.fixtureHold === true) {
        process.stdout.write("fixture_initializing\n");
        while (Atomics.load(stop, 0) === 0) Atomics.wait(stop, 0, 0, 100);
      }

      process.stdout.write("fixture_stdout_diagnostic\n");
      process.stderr.write("fixture_stderr_diagnostic\n");
      const workspaceRoot = typeof input.configuration.fixtureNativeRoot === "string" ? input.configuration.fixtureNativeRoot : scope.workspaceRoot;
      const budgetScope = typeof input.configuration.fixtureBudgetScope === "string" ? input.configuration.fixtureBudgetScope : scope.workspaceRoot;

      return { workspaceRoot, budgetScope, basisConfiguration: input.configuration,
        configuration: { ...input.configuration, rootRef: "original-fixture-root" }, driver: {
        async drive(run) {
          if (run.scope.workspaceRoot !== budgetScope) throw new Error("fixture_original_budget_scope_mismatch");

          calls++;
          process.stdout.write("fixture_actual_drive\n");
          run.publish({ message: "actual_fixture_progress", sourceRefs: [] });

          if (input.configuration.fixtureFailure === "transport-exit") process.exit(0);

          if (input.configuration.fixtureFailure === "drive-known") {
            setImmediate(() => {
              run.publish({ state: "ready", message: "central_domain_work_returned", sourceRefs: [] });
              process.stdout.write("fixture_late_failure_progress\n");
            });
            throw new Error("organization_sensitive_content");
          }

          if (input.configuration.fixtureFailure === "drive-private") throw Object.assign(
            new Error("organization_sensitive_content fixture-secret:/private/home?token=fixture-secret"),
            { code: "organization_sensitive_content:fixture-secret", reason: "fixture-secret:/private/profile" });

          if (input.configuration.fixtureLateReady === true && calls === 1) setImmediate(() => run.publish({
            state: "ready", message: "actual_late_domain_result", sourceRefs: ["fixture:late-domain-result"],
          }));

          return { state: "waiting", reason: "actual_fixture_result" };
        },
        async close() { process.stdout.write("fixture_original_close\n"); },
      } };
    },
  });
}
