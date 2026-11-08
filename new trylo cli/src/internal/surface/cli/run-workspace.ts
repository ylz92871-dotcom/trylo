import path from "node:path";
import type { CliContext } from "./context.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { fail, type RunFailure } from "./run-failure.js";

export function resolveWorkspaceRoot(ctx: CliContext, requested: string | undefined): string | RunFailure {
  const root = requested === undefined ? ctx.cwd : path.resolve(ctx.cwd, requested);
  return ctx.isDirectory(root) ? root : fail(EXIT_CODES.USAGE, `workspace is not a directory: ${root}`,
    "pass --workspace <path> pointing at an existing directory");
}
