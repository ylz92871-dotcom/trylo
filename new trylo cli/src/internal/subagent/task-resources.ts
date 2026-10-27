import { SubagentGovernanceError } from "./governance.js";

/** The composition root stops resources owned by a logical task, not one round. */
export type SubagentTaskResources = {
  /** Resolve only after every owned resource has a confirmed terminal receipt. */
  stop(taskId: string): Promise<void>;
};

type StopState = { readonly kind: "idle" }
  | { readonly kind: "stopping"; readonly result: Promise<void> }
  | { readonly kind: "failed"; readonly message: string };

export type TaskResourceStopSnapshot = { readonly status: "stopping" }
  | { readonly status: "failed"; readonly message: string };

/** Shared by all executions of one task; a failed stop remains retryable. */
export class TaskResourceStop {
  private state: StopState = { kind: "idle" };

  isHeld(): boolean { return this.state.kind !== "idle"; }

  snapshot(): TaskResourceStopSnapshot | undefined {
    if (this.state.kind === "stopping") return { status: "stopping" };
    if (this.state.kind === "failed") return { status: "failed", message: this.state.message };
    return undefined;
  }

  failure(): SubagentGovernanceError | undefined {
    if (this.state.kind === "stopping") {
      return new SubagentGovernanceError("agent_cleanup_pending", "Task resource cleanup is still pending");
    }
    if (this.state.kind === "failed") {
      return new SubagentGovernanceError("agent_cleanup_failed", this.state.message);
    }
    return undefined;
  }

  assertReady(): void {
    const failure = this.failure();
    if (failure !== undefined) throw failure;
  }

  stop(operation: () => Promise<void>): Promise<void> {
    if (this.state.kind === "stopping") return this.state.result;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
    const fail = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { kind: "failed", message };
      reject(new SubagentGovernanceError("agent_cleanup_failed", message));
    };
    // Register the hold before cancellation can notify reentrant observers.
    this.state = { kind: "stopping", result };
    try { void operation().then(() => { this.state = { kind: "idle" }; resolve(); }, fail); }
    catch (error) { fail(error); }
    return result;
  }
}
