import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { resolveWorkspaceRoot } from "./run-workspace.js";
import { fields, identity } from "../../validation/json-shape.js";
import type { CliContext } from "./context.js";
import type { CentralLearningCommandOptions } from "./args-central-learning.js";

export async function handleCentralLearning(ctx: CliContext, command: CentralLearningCommandOptions): Promise<ExitCode> {
  const fail = (reason: string, code: ExitCode) => {
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central", status: "failed", reason })}\n`);
    return code;
  };
  let input: unknown;

  try {
    const text = await ctx.readStdin();
    if (text.length > 65536) return fail("central_input_capacity", EXIT_CODES.USAGE);
    input = JSON.parse(text);
  }
  catch { return fail("central_input_invalid", EXIT_CODES.USAGE); }

  if (command.centralOperation === "skill") return (await import("./commands-central-skill.js")).handleCentralSkill(ctx, input);

  if (command.centralOperation === "runtime") return (await import("./central-runtime-command.js")).handleCentralRuntimeCommand(ctx, input);

  if (!fields(input, ["workspaceRoot"]) || !identity(input.workspaceRoot)) return fail("central_input_invalid", EXIT_CODES.USAGE);

  const scope = resolveWorkspaceRoot(ctx, input.workspaceRoot);
  if (typeof scope !== "string") return fail("workspace_unavailable", scope.exitCode);

  const { createBoardReader } = await import("../../adapters/learning-store/file-event-store.js");
  const { methodBoardRoot } = await import("./learning-sink.js");
  const { centralLearningReadModel } = await import("./central-learning-read-model.js");
  const read = await createBoardReader(methodBoardRoot(ctx.homeDir, ctx.env)).load();
  if (!read.ok) return fail(read.reason, EXIT_CODES.CONFIG);

  ctx.stdout(`${JSON.stringify(centralLearningReadModel(read.state, scope))}\n`);

  return EXIT_CODES.OK;
}
