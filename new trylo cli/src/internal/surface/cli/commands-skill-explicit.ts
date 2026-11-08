import { createJournalSkillOpportunity } from "../../learning/agent/subsystems/skill/host/index.js";
import { isSkillExplicitInput, skillFailureCode } from "../../learning/agent/subsystems/skill/index.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { createHermesSkillRuntime } from "./hermes-skill-runtime.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { resolveWorkspaceRoot } from "./run-workspace.js";
import { listSessions, sessionsDir } from "./session-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";

/** Explicit UI request selects one real journal session; renderer summaries cannot substitute task evidence. */
export async function handleSkillExplicit(ctx: CliContext): Promise<ExitCode> {
  const fail = (reason: string, code: ExitCode) => {
    ctx.stdout(`${JSON.stringify({ ok: false, status: code === EXIT_CODES.CANCELLED ? "cancelled" : "failed", reason })}\n`);
    return code;
  };
  let input: unknown;

  try {
    const raw = await ctx.readStdin();
    if (raw.length > 65_536) return fail("invalid_skill_explicit_input", EXIT_CODES.USAGE);
    input = JSON.parse(raw);
  }
  catch { return fail("invalid_skill_explicit_input", EXIT_CODES.USAGE); }

  if (!isSkillExplicitInput(input)) return fail("invalid_skill_explicit_input", EXIT_CODES.USAGE);

  const workspaceRoot = resolveWorkspaceRoot(ctx, input.workspaceRoot);
  if (typeof workspaceRoot !== "string") return fail("workspace_unavailable", workspaceRoot.exitCode);

  const selected = input, cancellation = observeRunCancellation(ctx);
  let runtime: ReturnType<typeof createHermesSkillRuntime> | undefined;

  try {
    const read = createJournalSkillOpportunity({ workspaceRoot, workspaceId: workspaceIdentity(workspaceRoot),
      sessions: () => listSessions(ctx, sessionsDir(ctx.homeDir, ctx.env)).filter(item => item.id === selected.sessionId),
      ...(selected.turnId === undefined ? {} : { source: { sessionId: selected.sessionId, turnId: selected.turnId } }) });
    const source = await read(cancellation.signal);

    if (cancellation.signal.aborted) return fail("learning_aborted", EXIT_CODES.CANCELLED);

    if (source === undefined) return fail("hermes_skill_source_unavailable", EXIT_CODES.EXECUTION_FAILURE);

    runtime = createHermesSkillRuntime({ ...ctx, cwd: workspaceRoot }, undefined, {
      opportunity: async () => ({ ...source, trigger: "explicit", learnRequest: selected.learnRequest }) });
    const result = await runtime.learn({ subsystem: "skill", allowance: selected.allowance }, cancellation.signal);

    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, subsystem: "skill", ...result })}\n`);

    return result.status === "cancelled" ? EXIT_CODES.CANCELLED : result.status === "failed" ? EXIT_CODES.EXECUTION_FAILURE : EXIT_CODES.OK;
  } catch (error) { return fail(skillFailureCode(error, "hermes_skill_explicit_unavailable"), cancellation.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.EXECUTION_FAILURE); }
  finally {
    cancellation.close();
    runtime?.close();
  }
}
