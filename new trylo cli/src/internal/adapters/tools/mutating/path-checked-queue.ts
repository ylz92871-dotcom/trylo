import path from "node:path";
import type { SandboxPolicy } from "../../../ports/tools.js";
import { resolveInsideWorkspace, resolveWriteTarget } from "../shared/workspace.js";
import type { WriteQueue } from "./atomic-write.js";

export class MutationPathError extends Error {
  readonly code = "path_changed_before_commit";
}

function physicalTarget(policy: SandboxPolicy, absolute: string): string {
  const write = resolveWriteTarget(policy.workspaceRoot, absolute, policy.fileAccess, policy.workspaceAlias);
  const read = resolveInsideWorkspace(policy.workspaceRoot, absolute, policy.fileAccess, policy.workspaceAlias);
  if (!write.ok || !read.ok || path.relative(absolute, write.absolutePath) !== "") {
    throw new MutationPathError("The admitted file path changed or escaped its scope before commit; no queued mutation was applied.");
  }
  return read.absolutePath;
}

/** A permission verdict made before waiting is rechecked inside the shared write lock. */
export function pathCheckedQueue(queue: WriteQueue, policy: SandboxPolicy): WriteQueue {
  return {
    exclusive(absolute, job) {
      const admitted = physicalTarget(policy, absolute);
      return queue.exclusive(absolute, async () => {
        if (path.relative(admitted, physicalTarget(policy, absolute)) !== "") {
          throw new MutationPathError("The file now points at a different physical target; the queued mutation was refused.");
        }
        return job();
      });
    },
  };
}
