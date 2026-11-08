import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { tryloHome } from "./session-paths.js";
import { openToolEvolutionSession } from "./tool-evolution-session.js";
import type { FrozenToolEvolutionModel } from "./tool-evolution-provider.js";
import { workToolLearningPipeline } from "../../learning/agent/subsystems/tool/runtime/index.js";
import type { ToolPipelineServices } from "../../learning/agent/subsystems/tool/runtime/index.js";
import type { ToolEvolutionOutcome } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { nextToolLearningDispatch } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { dispatchToolLearningWorker } from "../../learning/agent/subsystems/tool/adapters/evolution/background-worker.js";
import { hostNodeExecutable } from "../../adapters/sandbox/executable.js";
import { createToolLearningFunding } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { planForJob } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { adaptExistingNpmTool } from "./tool-npm-adaptation-wiring.js";
import { ToolLearningServiceError } from "../../learning/agent/subsystems/tool/domain/evolution/service-error.js";
import { toolResearchServices } from "./tool-research-wiring.js";
import type { ManagedToolFundingBinding } from "../../learning/agent/subsystems/tool/runtime/learning-funding.js";

export async function runToolCycle(ctx: CliContext, input: {
  readonly boardRoot: string; readonly scope: string; readonly run: RunCommandOptions; readonly mode: "manual" | "after_turn";
  readonly signal: AbortSignal; readonly jobIds?: readonly string[]; readonly maxJobs?: number; readonly generationTimeoutMs?: number;
  readonly centralScope?: string;
  readonly managedBinding?: ManagedToolFundingBinding;
  readonly frozenModel?: FrozenToolEvolutionModel;
}) {
  let session: ReturnType<typeof openToolEvolutionSession> | undefined;
  const funding = createToolLearningFunding({ boardRoot: input.boardRoot, scope: input.scope, centralScope: input.centralScope ?? ctx.cwd,
    ...(input.managedBinding === undefined ? {} : { managedBinding: input.managedBinding }), now: ctx.now });
  const activeSession = () => {
    session ??= openToolEvolutionSession(ctx, input.run, { ...input, funding });
    if ("exitCode" in session) throw new Error("provider_configuration_unavailable");
    return session;
  };
  const ensureFunding = async (admission: { readonly jobId: string }) => {
    const loaded = await createBoardReader(input.boardRoot).load();
    const plan = loaded.ok ? planForJob(loaded.state, admission.jobId) : undefined;
    if (plan === undefined || await funding.allowance(plan) === undefined) throw new ToolLearningServiceError("learning_allowance_required");
  };
  const services: ToolPipelineServices = {
    productionRegression: "preserve",
    ...(input.managedBinding?.centralSourceContext === undefined ? {} : { centralSourceContext: input.managedBinding.centralSourceContext }),
    ...toolResearchServices(ctx, input),

    adapt: async (plan, parentVersionId, adaptation, signal, admission) => {
      await ensureFunding(admission);
      return adaptExistingNpmTool(ctx, { ...input, plan, parentVersionId, adaptation, signal, admission, funding, session: activeSession() });
    },

    allowance: plan => funding.allowance(plan),

    releaseAllowance: async () => {
      try { if (session !== undefined && !("exitCode" in session)) await session.retireWorkers(); }
      finally { await funding.release(); }
    },

    plan: (context, signal) => activeSession().plan(context, signal),

    compose: async (request, descriptor, signal, _feedback, admission) => {
      await ensureFunding(admission);
      return activeSession().compose(request, descriptor, signal, admission);
    },

    executionAuthorized: input.mode === "manual" || (input.run.allowTools?.includes("run_shell") === true && input.run.denyTools?.includes("run_shell") !== true),

    async evolve(request, signal, feedback, admission, requirements): Promise<ToolEvolutionOutcome> {
      await ensureFunding(admission);
      return activeSession().evolve(request, signal, feedback, admission, requirements);
    },
  };

  try { return await workToolLearningPipeline({ ...input, now: ctx.now, services }); }
  finally { if (session !== undefined && !("exitCode" in session)) await session.close(); }
}

/** Dispatch only: the report boundary and turn-close boundary both use an isolated worker.
 * The running task keeps its frozen catalog; generated assets take effect at a later mount boundary. */
export function afterTurnToolCycle(ctx: Pick<CliContext, "cwd" | "homeDir" | "env" | "stderr">, input: {
  readonly workspaceId: string; readonly run: RunCommandOptions; readonly signal?: AbortSignal;
  readonly dispatch?: typeof dispatchToolLearningWorker;
}) {
  return async (jobIds: readonly string[]) => {
    if (input.signal?.aborted === true) return;

    const boardRoot = path.join(tryloHome(ctx.homeDir, ctx.env), "learning", "board");
    const authorized = input.run.allowTools?.includes("run_shell") === true && input.run.denyTools?.includes("run_shell") !== true;
    const selected = await nextToolLearningDispatch(boardRoot, input.workspaceId, authorized, jobIds.length === 0 ? undefined : jobIds);
    if (!selected.ok) {
      ctx.stderr(`tool learning: dispatch unavailable (${selected.code})\n`);
      return;
    }

    if (selected.jobId === undefined || Boolean(input.signal?.aborted)) return;

    const args = ["tools", "work", "--after-turn", "--scope", input.workspaceId, "--job-id", selected.jobId, "--max-jobs", "1"];

    for (const [flag, value] of [["--provider", input.run.provider], ["--model", input.run.model], ["--endpoint", input.run.endpoint]]) {
      if (value !== undefined && flag !== undefined) args.push(flag, value);
    }

    if (authorized) args.push("--allow-tools", "run_shell");

    const result = await (input.dispatch ?? dispatchToolLearningWorker)({ nodeExecutable: hostNodeExecutable(),
      entrypoint: fileURLToPath(new URL("../../../cmd/trylo/main.js", import.meta.url)), cwd: ctx.cwd,
      env: { ...ctx.env, TRYLO_HOME: tryloHome(ctx.homeDir, ctx.env) }, args });

    ctx.stderr(result.ok ? `tool learning: ${selected.jobId} dispatched to worker ${result.pid}\n` : `tool learning: dispatch unavailable (${result.code}); task remains queued\n`);
  };
}
