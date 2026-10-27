import type { TeamRepresentationVerdict } from "../protocol/team-representation.js";
import { SubagentGovernanceError } from "./governance.js";
import type { TaskResourceStop } from "./task-resources.js";

type ImplementationWorker = {
  readonly resourceStop: TaskResourceStop;
  stop(reason: string): Promise<void>;
};

/** One representation barrier; task owners retain native cleanup facts. */
export class TeamRepresentationControl {
  private verdict: TeamRepresentationVerdict | undefined;

  constructor(private readonly inspect: ((output: string) => TeamRepresentationVerdict) | undefined,
    private readonly workers: () => ReadonlyArray<ImplementationWorker>, private readonly changed: () => void) {}

  inputQueued(role: string): void {
    if (role !== "person" || this.inspect === undefined) return;
    this.verdict = undefined;
    void this.stopWorkers("team_representation_pending");
  }

  failure(role: string): SubagentGovernanceError | undefined {
    if (role !== "worker" || this.inspect === undefined) return;
    if (this.verdict?.ready !== true) return new SubagentGovernanceError(
      this.verdict === undefined ? "team_representation_pending" : "team_representation_held",
      this.verdict?.reason ?? "Collect the Person member's representation before dispatching implementation");
    for (const worker of this.workers()) {
      const failure = worker.resourceStop.failure();
      if (failure !== undefined) return failure;
    }
    return undefined;
  }

  async observe(role: string, output: string): Promise<void> {
    if (role !== "person" || this.inspect === undefined) return;
    this.verdict = this.inspect(output);
    if (!this.verdict.ready) await this.stopWorkers("team_representation_held");
  }

  private async stopWorkers(reason: string): Promise<void> {
    await Promise.all(this.workers().map(async worker => {
      try { await worker.stop(reason); }
      catch (error) {
        if (!(error instanceof SubagentGovernanceError) || error.code !== "agent_cleanup_failed") throw error;
        // TaskResourceStop retains this failure. wait_agent exposes it and
        // failure() blocks implementation until an explicit stop retry succeeds.
      }
    }));
    this.changed();
  }
}
