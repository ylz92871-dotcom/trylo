import { canonicalRuntimeRoot } from "../../adapters/central-learning-runtime/files-contract.js";
import type { RuntimeFingerprint } from "../../ports/session.js";
import type { CliContext } from "./context.js";
import { workspaceIdentity } from "./workspace-identity.js";

type WorkspaceHeader = Pick<RuntimeFingerprint, "workspaceId" | "workspaceRoot">;

/** Read compatibility is witnessed by the host or by this journal's exact original root; native IDs never change. */
export function createRuntimeSessionWorkspaceAccess(options: { readonly ctx: CliContext; readonly workspaceId: string }): {
  readonly compatibleWorkspaceIds: readonly string[];
  accepts(header: WorkspaceHeader): boolean;
  matchesHeader(header: WorkspaceHeader, body: WorkspaceHeader): boolean;
} {
  const identity = options.ctx.workspaceIdentity;
  const compatibleWorkspaceIds = [...new Set([options.workspaceId, ...(identity?.compatibleWorkspaceIds ?? [])])];
  const accepts = (header: WorkspaceHeader): boolean => {
    if (header.workspaceRoot === undefined) return compatibleWorkspaceIds.includes(header.workspaceId);

    if (workspaceIdentity(header.workspaceRoot) !== header.workspaceId) return false;

    try {
      canonicalRuntimeRoot(header.workspaceRoot);

      if (identity === undefined || options.ctx.realPath === undefined) {
        return header.workspaceRoot === options.ctx.cwd && compatibleWorkspaceIds.includes(header.workspaceId);
      }

      const physical = options.ctx.realPath(header.workspaceRoot);
      if (physical === undefined || canonicalRuntimeRoot(physical) !== identity.physicalRoot) return false;

      if (!compatibleWorkspaceIds.includes(header.workspaceId)) compatibleWorkspaceIds.push(header.workspaceId);

      return true;
    } catch { return false; } // Missing filesystem evidence cannot establish an additional native identity.
  };

  return { compatibleWorkspaceIds, accepts,
    matchesHeader: (header, body) => header.workspaceId === body.workspaceId && header.workspaceRoot === body.workspaceRoot && accepts(body),
  };
}
