import { createNodeFileSystemReader } from "../../../../../../adapters/tools/read-only/node-fs.js";
import { resolveInsideWorkspace } from "../../../../../../adapters/tools/shared/workspace.js";
import { contentHashOf } from "../../../../../control/hash.js";
import type { LoopPorts } from "../../../../../../loop/runner.js";
import type { PermissionPort } from "../../../../../../ports/permission.js";
import type { JsonObject, JsonValue } from "../../../../../../protocol/envelope.js";
import { jsonOutput } from "../../application/turn-facts.js";
import type { CheckArtifactAccess } from "../../application/turn-contracts.js";

/** Existing permission-aware artifact read-back, lent to the turn application as a narrow port. */
export function createCheckArtifactAccess(input: { readonly workspaceRoot: string; readonly permission: PermissionPort;
  readonly tools: LoopPorts["tools"]; readonly grants: LoopPorts["grants"]; readonly warn: (code: string) => void }): CheckArtifactAccess {
  const tools = input.tools, warn = input.warn;
  const reader = createNodeFileSystemReader();
  return { read: readArtifacts, same: sameArtifact };

  async function readArtifacts(paths: readonly string[], readSignal: AbortSignal): Promise<JsonValue | undefined> {
    const readBinding = tools.snapshot().find(binding => binding.name === "read_file");
    if (input.permission.isDenied?.("read_file") === true || input.grants?.isDenied("read_file") === true
      || readBinding === undefined || readBinding.needsApproval || paths.length > 4) {
      warn("artifact_read_not_available");
      return undefined;
    }

    const artifacts: JsonObject[] = [];

    for (const file of [...new Set(paths)]) {
      if (readSignal.aborted) return undefined;

      const target = resolveInsideWorkspace(input.workspaceRoot, file);
      if (!target.ok) {
        warn(target.code);
        return undefined;
      }

      try {
        const text = await reader.readFileUtf8Bounded!(target.absolutePath, 4096, readSignal);
        if (text === undefined) {
          warn("artifact_read_capacity");
          return undefined;
        }
        artifacts.push({ path: file, content: jsonOutput(text), contentHash: contentHashOf(text) });
      } catch {
        warn(readSignal.aborted ? "artifact_read_cancelled" : "artifact_read_failed");
        return undefined;
      }
    }

    return artifacts.length === 1 ? artifacts[0]!.content! : { artifacts };
  }

  function sameArtifact(first: string, second: string): boolean {
    const a = resolveInsideWorkspace(input.workspaceRoot, first), b = resolveInsideWorkspace(input.workspaceRoot, second);
    return a.ok && b.ok && a.absolutePath.toLowerCase() === b.absolutePath.toLowerCase();
  }
}
