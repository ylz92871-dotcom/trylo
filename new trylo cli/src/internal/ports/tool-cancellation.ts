import type { ToolPort } from "./tools.js";

/** Notify every possible owner before yielding. An unrelated port's async
 * acknowledgement must not let an active effect finish ahead of its cancel.
 */
export async function cancelToolPorts(ports: ReadonlyArray<Pick<ToolPort, "cancel">>, id: string): Promise<void> {
  const attempts = ports.map(port => {
    try { return port.cancel(id); }
    catch (error) { return Promise.reject(error); }
  });
  const settled = await Promise.allSettled(attempts);
  const failures: unknown[] = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Tool cancellation failed in one or more ports");
}
