import type { SessionOptionsV2 } from "./session-types-v2.js";
import { systemTimerScheduler, type TimerHandle } from "../../../../../subagent/scheduler.js";

/** Separate learning worker. Sensors wake it; they never execute its analysis. */
export function createCollaborationDriverV2(options: SessionOptionsV2) {
  let worker: Promise<void> | undefined;
  let requested = false, closed = false, recoveryRequested = true;
  let claimTimer: TimerHandle | undefined;
  const schedule = options.schedule ?? systemTimerScheduler;
  const clearClaimTimer = (): void => {
    claimTimer?.cancel();
    claimTimer = undefined;
  };
  const controller = new AbortController();
  const abort = () => controller.abort();

  options.signal?.addEventListener("abort", abort, { once: true });
  const report = async (result: Awaited<ReturnType<SessionOptionsV2["subsystem"]["invoke"]>>): Promise<void> => {
    if (result.ok) return;

    options.warn(`collaboration_cycle:${result.reason}`);

    if (result.reason !== "cycle_claim_active" || closed) return;

    const state = await options.subsystem.inspect(options.scope);
    const claim = state.ok ? state.cycles.find(cycle => cycle.cycleId === result.cycleId) : undefined;
    if (claim?.claimExpiresAt === undefined) return;

    clearClaimTimer();
    claimTimer = schedule(Math.max(250, Date.parse(claim.claimExpiresAt) - Date.parse(options.now())), () => {
      recoveryRequested = true;
      wake();
    });
  };
  const run = async (): Promise<void> => {
    while (requested && !closed && options.enabled() && !controller.signal.aborted) {
      requested = false;
      try {
        if (recoveryRequested) {
          recoveryRequested = false;
          const handled: string[] = [];

          // Recover at most two already-funded grants at startup. The subsystem
          // selects pending work and preserves each original reservation/lease.
          for (let recovered = 0; recovered < 2 && options.enabled() && !controller.signal.aborted; recovered += 1) {
            const result = await options.subsystem.resumePending({ scope: options.scope, signal: controller.signal, excludeRequestIds: handled });

            await report(result);

            if (result.cycleId === undefined) break;

            const state = await options.subsystem.inspect(options.scope);
            const previous = state.ok ? state.cycles.find(cycle => cycle.cycleId === result.cycleId) : undefined;
            if (previous === undefined) break;

            handled.push(previous.requestId);
          }
        }

        if (!options.enabled() || controller.signal.aborted) return;

        const result = await options.subsystem.invoke({ subsystem: "collaboration", requestId: options.requestId,
          scope: options.scope, grant: options.grant, signal: controller.signal });

        await report(result);
      } catch {
        // A bounded worker failure never becomes an execution failure or an implicit retry.
        options.warn("collaboration_cycle_unavailable");
        requested = false;
      }
    }
  };
  const wake = (): void => {
    if (closed || !options.enabled() || controller.signal.aborted || options.signal?.aborted) return;
    requested = true;
    worker ??= Promise.resolve().then(run).finally(() => {
      worker = undefined;
      if (requested) wake();
    });
  };

  return {
    wake,
    async drain() { while (worker !== undefined) await worker; },
    async close() {
      clearClaimTimer();
      if (options.signal?.aborted || !options.enabled()) controller.abort();
      while (worker !== undefined) await worker;
      closed = true;
      clearClaimTimer();
      options.signal?.removeEventListener("abort", abort);
    },
  };
}
