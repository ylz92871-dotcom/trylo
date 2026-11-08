import { canonicalRuntimeRoot } from "../../adapters/central-learning-runtime/files-contract.js";
import type { CliContext } from "./context.js";
import type { CentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";
import { workspaceIdentity } from "./workspace-identity.js";

export type CentralRuntimeReadWorkspaceSnapshot = {
  readonly revision: number;
  readonly roots: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly scopes: readonly string[];
};

export type CentralRuntimeReadWorkspaceAccess = {
  readonly identity: CentralRuntimeWorkspaceIdentity | undefined;
  snapshot(): CentralRuntimeReadWorkspaceSnapshot;
  observeSourceWorkspaceRoots(rawRoots: readonly string[]): CentralRuntimeReadWorkspaceSnapshot;
};

/** Worker-local read evidence. Native identity and its funding reference remain fixed for the owner's lifetime. */
export function createCentralRuntimeReadWorkspaceAccess(ctx: CliContext): CentralRuntimeReadWorkspaceAccess {
  const descriptor = ctx.workspaceIdentity, exactRoot = ctx.cwd, realPath = ctx.realPath;
  const fixed = descriptor === undefined ? undefined : { ...descriptor,
    ...(descriptor.rootRef === undefined ? {} : { rootRef: Object.freeze({ ...descriptor.rootRef }) }) };
  let current = readSnapshot(0, [exactRoot, ...(descriptor === undefined ? [] : [descriptor.workspaceRoot, ...descriptor.compatibleRoots])],
    descriptor === undefined ? [] : [descriptor.workspaceId, ...descriptor.compatibleWorkspaceIds]);
  let identity = compatibleIdentity(fixed, current);

  return {
    get identity() { return identity; },
    snapshot: () => current,

    observeSourceWorkspaceRoots(rawRoots) {
      if (fixed === undefined) return current;

      const added: string[] = [];

      for (const raw of rawRoots) {
        if (current.roots.includes(raw) || added.includes(raw)) continue;
        try {
          if (canonicalRuntimeRoot(raw) !== raw) continue;

          if (realPath === undefined) {
            if (raw === exactRoot) added.push(raw);
            continue;
          }

          const physical = realPath(raw);
          if (physical !== undefined && canonicalRuntimeRoot(physical) === fixed.physicalRoot) added.push(raw);
        } catch { continue; } // An invalid hint or unavailable physical proof grants no read access.
      }

      if (added.length === 0) return current;

      current = readSnapshot(current.revision + 1, [...current.roots, ...added], current.workspaceIds);
      identity = compatibleIdentity(fixed, current);

      return current;
    },
  };
}

function readSnapshot(revision: number, rawRoots: readonly string[], nativeIds: readonly string[]): CentralRuntimeReadWorkspaceSnapshot {
  const roots = Object.freeze([...new Set(rawRoots)]);
  const workspaceIds = Object.freeze([...new Set([...nativeIds, ...roots.map(workspaceIdentity)])]);
  return Object.freeze({ revision, roots, workspaceIds, scopes: Object.freeze([...new Set([...roots, ...workspaceIds])]) });
}

function compatibleIdentity(fixed: CentralRuntimeWorkspaceIdentity | undefined, snapshot: CentralRuntimeReadWorkspaceSnapshot) {
  return fixed === undefined ? undefined : Object.freeze({ ...fixed,
    compatibleRoots: snapshot.roots, compatibleWorkspaceIds: snapshot.workspaceIds });
}
