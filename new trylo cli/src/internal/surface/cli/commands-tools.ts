import path from "node:path";
import type { CliContext } from "./context.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { TOOLS_USAGE, parseTools } from "./args-tools.js";
import type { RunCommandOptions } from "./args.js";
import type { ToolEvolutionRequest } from "../../learning/agent/subsystems/tool/domain/evolution/index.js";
import { createToolAcquisitionService } from "../../learning/agent/subsystems/tool/adapters/acquisition/search-service.js";
import { listToolEvolutionCandidates } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { parseToolEvolutionRequest } from "../../learning/agent/subsystems/tool/domain/evolution/index.js";
import { openToolEvolutionSession } from "./tool-evolution-session.js";
import { toolEvolutionExecution } from "./tool-evolution-execution.js";
import { prepareToolImprovement, readToolEvolutionTrials, runToolEvolutionTrial } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { tryloHome } from "./session-paths.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { reportFailure } from "./run-failure.js";
import { readToolCandidateUses, withdrawToolCandidate } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { isToolProductionCommand } from "./args-tool-production.js";
import { isToolInstallCommand } from "./args-tool-install.js";
import { readToolTaskFeedback, recordAndScheduleToolTaskFeedback } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { isToolContractCommand } from "./args-tool-contract.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";
import { workspaceIdentity } from "./wiring.js";

/** Explicit lab entry; the normal run/learning-off path never constructs these resources. */
export async function handleTools(ctx: CliContext, argv: readonly string[]): Promise<ExitCode> {
  const command = parseTools(argv);
  if (command.kind === "help") {
    ctx.stdout(`${TOOLS_USAGE}\n`);
    return EXIT_CODES.OK;
  }

  if (command.kind === "error") {
    ctx.stderr(`${command.message}\n${TOOLS_USAGE}\n`);
    return EXIT_CODES.USAGE;
  }

  if (isToolInstallCommand(command)) {
    const { handleToolInstall } = await import("./commands-tool-install.js");
    return handleToolInstall(ctx, command);
  }

  if (command.kind === "acquire-plan" || command.kind === "acquire") {
    const { handleToolAcquire } = await import("./commands-tool-acquire.js");
    return handleToolAcquire(ctx, command);
  }

  const boardRoot = path.join(tryloHome(ctx.homeDir, ctx.env), "learning", "board");

  if (isToolContractCommand(command)) {
    const { handleToolContract } = await import("./commands-tool-contract.js");
    return handleToolContract(ctx, command, boardRoot);
  }

  if (command.kind === "acquire-learning") {
    const { handleToolLearningAcquire } = await import("./commands-tool-learning-acquire.js");
    return handleToolLearningAcquire(ctx, command, boardRoot);
  }

  if (command.kind === "feedback" || command.kind === "feedbacks") {
    let feedback: unknown;

    if (command.kind === "feedback") {
      const raw = ctx.readFile(path.resolve(ctx.cwd, command.reportFile));
      if (raw === undefined || raw.length > 32_768) {
        ctx.stderr("feedback is unreadable or exceeds 32 KiB\n");
        return EXIT_CODES.USAGE;
      }
      try { feedback = JSON.parse(raw) as unknown; } catch {
        ctx.stderr("feedback must be JSON\n");
        return EXIT_CODES.USAGE;
      }
      if (typeof feedback !== "object" || feedback === null || Array.isArray(feedback)) return EXIT_CODES.USAGE;
    }

    const result = command.kind === "feedbacks" ? await readToolTaskFeedback(boardRoot, command.versionId)
      : await recordAndScheduleToolTaskFeedback(boardRoot, { ...feedback as Record<string, unknown>, source: "user" }, new Date(ctx.now()).toISOString());
    if (result.ok && command.kind === "feedback" && "feedbackVersionId" in result && typeof feedback === "object" && feedback !== null
      && "useIds" in feedback && Array.isArray(feedback.useIds)) {
      const ids = new Set(feedback.useIds), uses = await readToolCandidateUses(boardRoot, result.versionId);
      const selected = uses.ok ? uses.records.filter(use => ids.has(use.useId)) : [];

      // A feedback file may refer to a foreign workspace. Its source uses must
      // prove this exact root before notifying the root selected by this CLI.
      if (selected.length === ids.size && selected.length > 0 && selected.every(use => use.workspaceId === workspaceIdentity(path.resolve(ctx.cwd)))) {
        await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: path.resolve(ctx.cwd), reason: "tool_native_feedback_committed",
          sourceRefs: [result.feedbackVersionId, result.versionId] });
      }
    }

    ctx.stdout(`${JSON.stringify(result)}\n`);

    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  if (isToolProductionCommand(command)) {
    const { handleToolProduction } = await import("./commands-tool-production.js");
    return handleToolProduction(ctx, command, boardRoot);
  }

  if (command.kind === "recipe" || command.kind === "recipes" || command.kind === "jobs" || command.kind === "queue" || command.kind === "work" || command.kind === "expire" || command.kind === "status") {
    const { handleToolCycle } = await import("./commands-tool-cycle.js");
    return handleToolCycle(ctx, command, boardRoot);
  }

  if (command.kind === "withdraw") {
    const result = await withdrawToolCandidate(boardRoot, command.versionId, new Date(ctx.now()).toISOString());
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  if (command.kind === "use") {
    const { handleToolUse } = await import("./commands-tool-use.js");
    return handleToolUse(ctx, command, boardRoot);
  }

  if (command.kind === "uses") {
    const result = await readToolCandidateUses(boardRoot, command.versionId);
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  if (command.kind === "candidates") {
    const result = await listToolEvolutionCandidates(boardRoot);
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  if (command.kind === "trials") {
    const result = await readToolEvolutionTrials(boardRoot, command.versionId);
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  const cancellation = observeRunCancellation(ctx);

  try {
    if (command.kind === "search") {
      const result = await createToolAcquisitionService().search({ capability: command.capability,
        ...(command.platforms === undefined ? {} : { platforms: command.platforms }), signal: cancellation.signal });
      ctx.stdout(`${JSON.stringify(result)}\n`);
      return result.ok ? (result.value.status === "failed" ? EXIT_CODES.TEMPORARY : EXIT_CODES.OK)
        : result.code === "cancelled" ? EXIT_CODES.CANCELLED : EXIT_CODES.TEMPORARY;
    }

    const input = readRequest(ctx, command.requestFile);
    if (!input.ok) {
      ctx.stderr(`${input.code}: ${input.message}\n`);
      return EXIT_CODES.USAGE;
    }

    if (command.kind === "trial") {
      const execution = toolEvolutionExecution(ctx, command.run);
      const result = await runToolEvolutionTrial({ boardRoot, verifier: execution.verifier, now: ctx.now }, command.versionId, input.value, cancellation.signal);
      ctx.stdout(`${JSON.stringify(result)}\n`);
      return "kind" in result ? result.kind === "cancelled" ? EXIT_CODES.CANCELLED
        : result.record.verification.verdict === "pass" ? EXIT_CODES.OK : EXIT_CODES.EXECUTION_FAILURE : EXIT_CODES.CONFIG;
    }

    const parent = command.kind === "improve" ? command.versionId : input.value.prior?.versionId;
    const prepared = parent === undefined ? { ok: true as const, request: input.value, feedback: undefined }
      : await prepareToolImprovement(boardRoot, parent, input.value);
    if (!prepared.ok) {
      ctx.stdout(`${JSON.stringify(prepared)}\n`);
      return EXIT_CODES.CONFIG;
    }

    return await evolve(ctx, command.run, { boardRoot, signal: cancellation.signal, request: prepared.request,
      ...(command.generationTimeoutMs === undefined ? {} : { generationTimeoutMs: command.generationTimeoutMs }),
      ...(prepared.feedback === undefined ? {} : { initialFeedback: prepared.feedback }) });
  } catch (error) {
    ctx.stderr(`tool evolution failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return cancellation.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.CONFIG;
  } finally { cancellation.close(); }
}

function readRequest(ctx: CliContext, requestFile: string) {
  const raw = ctx.readFile(path.resolve(ctx.cwd, requestFile));
  if (raw === undefined || raw.length > 262_144) return { ok: false as const, code: "invalid_request", message: "request is unreadable or exceeds 256 KiB" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false as const, code: "invalid_json", message: "request is not JSON" }; }
  return parseToolEvolutionRequest(parsed);
}

async function evolve(ctx: CliContext, run: RunCommandOptions, input: {
  readonly boardRoot: string; readonly signal: AbortSignal; readonly request: ToolEvolutionRequest; readonly initialFeedback?: string; readonly generationTimeoutMs?: number;
}): Promise<ExitCode> {
  const session = openToolEvolutionSession(ctx, run, input);
  if ("exitCode" in session) return reportFailure(ctx, session);

  try {
    const result = await session.evolve(input.request, input.signal, input.initialFeedback);
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.kind === "candidate" ? EXIT_CODES.OK : result.kind === "cancelled" ? EXIT_CODES.CANCELLED : EXIT_CODES.CONFIG;
  } finally { await session.close(); }
}
