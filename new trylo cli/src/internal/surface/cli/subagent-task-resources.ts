import type { ProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import type { SubagentTaskResources } from "../../subagent/task-resources.js";
import type { ProcessSessionSnapshot } from "../../ports/process-session.js";

function isConfirmedAbsent(session: ProcessSessionSnapshot): boolean {
  if (session.status === "exited") return true;
  // Only a pipe spawn failure without an assigned PID proves nothing started.
  // A lost terminal or a process that already had a PID still needs confirmation.
  return session.status === "failed" && !session.tty && session.pid === undefined
    && session.end?.kind === "failed" && session.end.code === "process_spawn_failed";
}

/** A process registry remains the sole owner of native stop and exit facts. */
export function createSubagentTaskResources(sessions: ProcessSessionRegistry): SubagentTaskResources {
  return { async stop(taskId) {
    const owned = sessions.list().sessions.filter(session => session.ownerId === taskId && !isConfirmedAbsent(session));
    const results = await Promise.allSettled(owned.map(async session => {
      const result = await sessions.stop(session.id);
      if (!result.ok || result.end.kind !== "exited") {
        throw new Error(`Owned process ${session.id} has no confirmed exit receipt`);
      }
    }));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} owned process stop(s) remain unconfirmed`);
  } };
}
