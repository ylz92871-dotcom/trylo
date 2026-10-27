import type { ProcessSessionStopResult } from "../../ports/process-session.js";

/** Concurrent lifecycle owners receive one native stop and one shared receipt. */
export class SessionStopRequests {
  private readonly pending = new Map<string, Promise<ProcessSessionStopResult>>();

  run(id: string, stop: () => Promise<ProcessSessionStopResult>): Promise<ProcessSessionStopResult> {
    const existing = this.pending.get(id);
    if (existing !== undefined) return existing;
    const result = Promise.resolve().then(stop).finally(() => { this.pending.delete(id); });
    this.pending.set(id, result);
    return result;
  }
}
