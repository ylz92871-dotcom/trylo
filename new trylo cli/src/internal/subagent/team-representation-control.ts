import { formatTeamRepresentation, type TeamRepresentation, type TeamRepresentationVerdict } from "../protocol/team-representation.js";
import { SubagentGovernanceError } from "./governance.js";
import type { TaskResourceStop } from "./task-resources.js";

type ImplementationWorker = {
  readonly resourceStop: TaskResourceStop;
  stop(reason: string): Promise<void>;
};

/** One representation barrier; task owners retain native cleanup facts. */
export class TeamRepresentationControl {
  private readonly states = new Map<string, { readonly kind: "pending" } | { readonly kind: "submitted"; readonly value: TeamRepresentation }
    | { readonly kind: "settled"; readonly verdict: TeamRepresentationVerdict; readonly value?: TeamRepresentation }>();

  constructor(private readonly inspect: ((output: string) => TeamRepresentationVerdict) | undefined,
    private readonly workers: () => ReadonlyArray<ImplementationWorker>, private readonly changed: () => void,
    members: readonly string[] = []) {
    for (const member of members) this.states.set(member, { kind: "pending" });
  }

  inputQueued(role: string, member = "person"): void {
    if (role !== "person" || this.inspect === undefined) return;
    this.states.set(member, { kind: "pending" });
    void this.stopWorkers("team_representation_pending");
  }

  failure(role: string): SubagentGovernanceError | undefined {
    if (role !== "worker" || this.inspect === undefined) return;
    for (const state of this.states.values()) if (state.kind === "settled" && !state.verdict.ready) {
      return new SubagentGovernanceError("team_representation_held", state.verdict.reason);
    }
    if (this.states.size === 0 || [...this.states.values()].some(state => state.kind !== "settled")) {
      return new SubagentGovernanceError("team_representation_pending", "Collect every frozen Person member's current representation before implementation");
    }
    for (const worker of this.workers()) {
      const failure = worker.resourceStop.failure();
      if (failure !== undefined) return failure;
    }
    return undefined;
  }

  async submit(member: string, value: TeamRepresentation): Promise<void> {
    this.states.set(member, { kind: "submitted", value });
    if (value.vetoes.length > 0 || value.user_questions.length > 0) await this.stopWorkers("team_representation_held");
  }

  formatOutput(role: string, member: string, output: string): string {
    const state = this.states.get(member);
    const value = state?.kind === "submitted" || state?.kind === "settled" ? state.value : undefined;
    return role !== "person" || value === undefined ? output : `${output}\n\n${formatTeamRepresentation(value)}`;
  }

  async observe(role: string, output: string, member = "person"): Promise<void> {
    if (role !== "person" || this.inspect === undefined) return;
    const state = this.states.get(member);
    const value = state?.kind === "submitted" ? state.value : undefined;
    const verdict = this.inspect(output);
    this.states.set(member, { kind: "settled", verdict, ...(value === undefined ? {} : { value }) });
    if (!verdict.ready) await this.stopWorkers("team_representation_held");
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
