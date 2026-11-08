import path from "node:path";
import type { CliContext } from "./context.js";
import type { ToolCycleCommand } from "./args-tool-cycle.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { workspaceIdentity } from "./wiring.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { parseToolEvolutionRequest } from "../../learning/agent/subsystems/tool/domain/evolution/index.js";
import { registerToolLearningRecipe, enqueueToolLearningPlan, readToolLearningPipeline, expireToolLearningJob } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { runToolCycle } from "./tool-cycle-wiring.js";
import { readToolLearningStatus } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";

export async function handleToolCycle(ctx: CliContext, command: ToolCycleCommand, boardRoot: string) {
  const scope = workspaceIdentity(path.resolve(ctx.cwd));

  if (command.kind === "status") {
    const result = await readToolLearningStatus(boardRoot, scope);
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  if (command.kind === "expire") {
    const result = await expireToolLearningJob(boardRoot, command.jobId, new Date(ctx.now()).toISOString());
    const state = result.ok ? await readToolLearningPipeline(boardRoot) : undefined;
    if (state?.ok && state.jobs.some(job => job.jobId === command.jobId && job.scope === scope)) {
      await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd),
        reason: "tool_native_job_expired", sourceRefs: [command.jobId] });
    }

    ctx.stdout(`${JSON.stringify(result)}\n`);

    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  if (command.kind === "jobs" || command.kind === "recipes") {
    const result = await readToolLearningPipeline(boardRoot);
    ctx.stdout(`${JSON.stringify(result.ok ? { ok: true, workspaceId: scope, [command.kind]: result[command.kind] } : result)}\n`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  if (command.kind === "recipe") {
    const raw = ctx.readFile(path.resolve(ctx.cwd, command.requestFile));
    if (raw === undefined || raw.length > 262_144) {
      ctx.stderr("recipe is unreadable or exceeds 256 KiB\n");
      return EXIT_CODES.USAGE;
    }

    let value: unknown;

    try { value = JSON.parse(raw); } catch {
      ctx.stderr("recipe is not JSON\n");
      return EXIT_CODES.USAGE;
    }

    const parsed = parseToolEvolutionRequest(value);
    if (!parsed.ok) {
      ctx.stderr(`${parsed.code}: ${parsed.message}\n`);
      return EXIT_CODES.USAGE;
    }

    const request = command.workspace ? { ...parsed.value, scope } : parsed.value;
    const result = await registerToolLearningRecipe(boardRoot, { type: "tool_learning_recipe", schemaVersion: 1, automation: command.automation, request }, new Date(ctx.now()).toISOString());
    if (result.ok && request.scope === scope) await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd),
      reason: "tool_native_recipe_committed", sourceRefs: [result.versionId] });

    ctx.stdout(`${JSON.stringify({ ...result, workspaceId: scope, recipeScope: request.scope })}\n`);

    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  if (command.kind === "queue") {
    const result = await enqueueToolLearningPlan(boardRoot, { type: "tool_learning_plan", schemaVersion: 1, scope: command.scope ?? scope,
      capability: command.capability, createdAt: new Date(ctx.now()).toISOString(), trigger: { runId: ctx.newId("tool-request"),
        proposalKey: "user-requested", action: "user_requested", evidenceRefs: [] } });
    if (result.ok && (command.scope === undefined || command.scope === scope)) await notifyCommittedCentralRuntimeForSource(ctx,
      { workspaceRoot: path.resolve(ctx.cwd), reason: "tool_native_plan_queued", sourceRefs: [result.jobId, `plan:${result.jobId}`] });

    ctx.stdout(`${JSON.stringify(result)}\n`);

    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  const cancellation = observeRunCancellation(ctx);
  const work = new AbortController(), cancel = () => work.abort();

  cancellation.signal.addEventListener("abort", cancel, { once: true });

  if (cancellation.signal.aborted) cancel();

  try {
    const result = await runToolCycle(ctx, { boardRoot, scope: command.scope ?? scope, run: command.run, mode: command.mode, signal: work.signal,
      ...(command.jobId === undefined ? {} : { jobIds: [command.jobId] }),
      maxJobs: command.maxJobs, ...(command.generationTimeoutMs === undefined ? {} : { generationTimeoutMs: command.generationTimeoutMs }) });

    ctx.stdout(`${JSON.stringify(result)}\n`);

    if (!result.ok) return EXIT_CODES.CONFIG;

    if (result.cancelled) return EXIT_CODES.CANCELLED;

    const state = await readToolLearningPipeline(boardRoot);
    if (!state.ok) return EXIT_CODES.CONFIG;

    return result.results.some(item => !state.jobs.some(job => job.jobId === item.jobId
      && ["succeeded", "waiting_evidence", "waiting_approval"].includes(job.state))) ? EXIT_CODES.TEMPORARY : EXIT_CODES.OK;
  } finally {
    cancellation.signal.removeEventListener("abort", cancel);
    cancellation.close();
  }
}
