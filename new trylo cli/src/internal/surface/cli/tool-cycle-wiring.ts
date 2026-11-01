import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { tryloHome } from "./session-paths.js";
import { openToolEvolutionSession } from "./tool-evolution-session.js";
import { createToolAcquisitionService } from "../../adapters/tool-acquisition/search-service.js";
import { workToolLearningPipeline } from "../../integration/tool-learning/pipeline-worker.js";
import type { ToolPipelineServices } from "../../integration/tool-learning/pipeline-worker.js";
import type { ToolEvolutionOutcome } from "../../integration/tool-learning/evolution-runtime.js";
import { nextToolLearningDispatch } from "../../integration/tool-learning/pipeline-queue.js";
import { dispatchToolLearningWorker } from "../../adapters/tool-evolution/background-worker.js";
import { hostNodeExecutable } from "../../adapters/sandbox/executable.js";

export async function runToolCycle(ctx: CliContext, input: {
  readonly boardRoot: string; readonly scope: string; readonly run: RunCommandOptions; readonly mode: "manual" | "after_turn";
  readonly signal: AbortSignal; readonly jobIds?: readonly string[]; readonly maxJobs?: number; readonly generationTimeoutMs?: number;
}) {
  let session: ReturnType<typeof openToolEvolutionSession> | undefined;
  const acquisition = createToolAcquisitionService();
  const services: ToolPipelineServices = {
    executionAuthorized: input.mode === "manual" || (input.run.allowTools?.includes("run_shell") === true && input.run.denyTools?.includes("run_shell") !== true),
    async search(capability, signal) {
      const found = await acquisition.search({ capability, signal });
      if (!found.ok) return { status: "failed", candidates: [], failures: [{ platform: "all", stage: "search", code: found.code }] };
      return { status: found.value.status, candidates: found.value.candidates.map(candidate => ({ platform: candidate.ref.platform,
        id: candidate.ref.id, sourceUrl: candidate.sourceUrl, licenseSpdx: candidate.licenseSpdx,
        ...(candidate.ref.version === undefined ? {} : { version: candidate.ref.version }) })),
        failures: found.value.failures.map(failure => ({ platform: failure.platform, stage: failure.stage, code: failure.code })) };
    },
    async evolve(request, signal, feedback, admission): Promise<ToolEvolutionOutcome> {
      session ??= openToolEvolutionSession(ctx, input.run, input);
      if ("exitCode" in session) return { kind: "failed", code: "provider_configuration_unavailable", message: "worker provider is not configured", attempts: 0 };
      return session.evolve(request, signal, feedback, admission);
    },
  };
  try { return await workToolLearningPipeline({ ...input, now: ctx.now, services }); }
  finally { if (session !== undefined && !("exitCode" in session)) await session.close(); }
}

/** Called by the host only after the user's turn and tool resources have closed. */
export function afterTurnToolCycle(ctx: Pick<CliContext, "cwd" | "homeDir" | "env" | "stderr">, input: {
  readonly workspaceId: string; readonly run: RunCommandOptions; readonly signal?: AbortSignal;
  readonly dispatch?: typeof dispatchToolLearningWorker;
}) {
  return async (jobIds: readonly string[]) => {
    if (input.signal?.aborted === true) return;
    const boardRoot = path.join(tryloHome(ctx.homeDir, ctx.env), "learning", "board");
    const authorized = input.run.allowTools?.includes("run_shell") === true && input.run.denyTools?.includes("run_shell") !== true;
    const selected = await nextToolLearningDispatch(boardRoot, input.workspaceId, authorized, jobIds.length === 0 ? undefined : jobIds);
    if (!selected.ok) { ctx.stderr(`tool learning: dispatch unavailable (${selected.code})\n`); return; }
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
