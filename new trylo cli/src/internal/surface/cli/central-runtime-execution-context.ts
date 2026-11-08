import path from "node:path";
import { canonicalRuntimeRoot, runtimePathIdentity } from "../../adapters/central-learning-runtime/files-contract.js";
import { runtimeWorkspaceLocationMatches, type CentralRuntimeWorkspaceLocation } from "../../adapters/central-learning-runtime/workspace-location.js";
import type { CliContext } from "./context.js";

/** Restore only the host-witnessed workspace projection after crossing the private child boundary. */
export function centralRuntimeExecutionContext(ctx: CliContext, workspaceRoot: string,
  configuration: Readonly<Record<string, unknown>>, location?: CentralRuntimeWorkspaceLocation): CliContext {
  if (location === undefined) return ctx;

  if (!runtimeWorkspaceLocationMatches(location, workspaceRoot, configuration)) throw new Error("runtime_workspace_root_mismatch");

  const physical = ctx.realPath?.(location.physicalRoot), original = ctx.realPath?.(location.scope);
  if (physical === undefined || !ctx.isDirectory(physical)
    || runtimePathIdentity(canonicalRuntimeRoot(physical)) !== runtimePathIdentity(location.physicalRoot)
    || original !== undefined && runtimePathIdentity(canonicalRuntimeRoot(original)) !== runtimePathIdentity(location.physicalRoot)) {
    throw new Error("runtime_workspace_root_mismatch");
  }

  const locate = (candidate: string) => {
    const relative = path.relative(location.scope, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.join(physical, relative) : candidate;
  };

  return { ...ctx,
    readFile: candidate => ctx.readFile(locate(candidate)), readDir: candidate => ctx.readDir(locate(candidate)),
    isDirectory: candidate => ctx.isDirectory(locate(candidate)), realPath: candidate => ctx.realPath?.(locate(candidate)),
    writeFile: (candidate, value) => ctx.writeFile(locate(candidate), value),
  };
}
