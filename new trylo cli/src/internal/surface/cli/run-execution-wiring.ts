import { createNodeSpawner, type ShellSpawner } from "../../adapters/tools/mutating/shell-spawn.js";
import { createWindowsShellBoundary } from "../../adapters/sandbox/windows-shell-boundary.js";
import type { ProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import { createSessionViewForRun } from "./session-view-wiring.js";
import { hostProcessEnvironment } from "../../adapters/sandbox/executable.js";
import type { ShellIsolation } from "../../ports/isolation.js";
import type { FileAccessMode } from "../../ports/tools.js";
import type { ImageReferenceRegistry } from "../../ports/image-reference-access.js";
import { createImageReferenceRegistry } from "../../adapters/media/image-reference-access.js";

export type RunExecution = {
  readonly imageReferences?: ImageReferenceRegistry;
  readonly sessions: ProcessSessionRegistry;
  readonly spawner: ShellSpawner;
  readonly close: () => Promise<void>;
};

/** The prepared session lends this entire execution resource, never half its policy. */
export function createRunExecution(workspaceRoot: string, options: {
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  shellIsolation?: ShellIsolation;
  fileAccess?: FileAccessMode;
} = {}): RunExecution {
  const platform = options.platform ?? process.platform;
  const sessions = createSessionViewForRun(options);
  const imageReferences = options.fileAccess === undefined || options.fileAccess === "workspace" ? undefined : createImageReferenceRegistry();
  // Desktop supplies host explicitly: its permission service owns every command
  // approval. Standalone callers retain strict isolation and never fall back on failure.
  const boundary = platform === "win32" && options.shellIsolation !== "host"
    ? createWindowsShellBoundary(workspaceRoot, options.env ?? hostProcessEnvironment()) : undefined;
  const spawner = boundary === undefined ? createNodeSpawner() : boundary.spawner(createNodeSpawner(boundary.helperEnvironment));
  return {
    ...(imageReferences === undefined ? {} : { imageReferences }),
    sessions: boundary === undefined ? sessions : {
      ...sessions,
      start: async request => sessions.start({ ...request, argv: await boundary.wrap(request.argv), env: boundary.helperEnvironment() }),
    },
    spawner,
    close: async () => {
      // Do not revoke a live child's approved ACL before its tree is drained.
      try { await sessions.shutdown(); await boundary?.close(); }
      finally { imageReferences?.clear(); }
    },
  };
}
