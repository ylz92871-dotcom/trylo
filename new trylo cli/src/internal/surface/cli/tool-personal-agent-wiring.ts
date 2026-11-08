import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { createToolPersonalAgentLearning } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { runToolCycle } from "./tool-cycle-wiring.js";

/** Host owns permission/configuration; the tool subsystem owns focus and funds. */
export function toolPersonalAgentLearning(ctx: CliContext, input: { readonly boardRoot: string; readonly scope: string;
  readonly centralScope: string; readonly run: RunCommandOptions; readonly enabled: boolean }) {
  return createToolPersonalAgentLearning({ ...input, now: ctx.now,
    authorized: () => input.enabled && input.run.allowTools?.includes("run_shell") === true && input.run.denyTools?.includes("run_shell") !== true,
    run: (jobId, signal) => runToolCycle(ctx, { ...input, jobIds: [jobId], signal, mode: "after_turn", maxJobs: 1 }),
  });
}
