import { createClientForEntry, type McpClientOpen } from "../../../../../adapters/mcp-runtime/factory.js";
import { createMcpStdioClient } from "../../../../../adapters/mcp-stdio/client.js";
import type { McpStdioClient } from "../../../../../ports/mcp-client.js";
import type { McpServerEntry } from "../../../../../ports/mcp-registry.js";
import type { HermesToolProfile } from "./client.js";
import { hermesSkillReadName } from "../skill-read.js";
import { isCompleteHermesViewOutput } from "./view-transport.js";
import { HERMES_LEGACY_SERVER_NAME, isLegacyHermesSkillTool } from "./legacy-profile.js";
import { skillProposalReceipt } from "../proposal-receipts.js";
import type { SkillProposalReceipt } from "../review-process.js";

type ClientFor = (entry: McpServerEntry, cwd: string) => McpClientOpen;

export type HermesSkillViewObserver = {
  readonly viewed: (input: { readonly name: string }, signal?: AbortSignal) => Promise<unknown>;
  /** An observed native staging reply, never an approval or complete review. */
  readonly staged?: (receipt: SkillProposalReceipt, signal?: AbortSignal) => Promise<unknown>;
  readonly warn: (code: string) => void;
};

/** Restrict this Hermes server before mounting; preserve every other server and user tool selection. */
export function hermesProfileClientFor(profile: HermesToolProfile, clientFor?: ClientFor,
  observer?: HermesSkillViewObserver, buildStdio: typeof createMcpStdioClient = createMcpStdioClient): ClientFor {
  const serverName = profile.name, allowed = new Set(profile.allowedTools);
  const defaultClientFor: ClientFor = (entry, cwd) => {
    if (entry.name !== serverName || entry.transport !== "stdio") return createClientForEntry(entry, cwd);
    // Native Python imports may contend with a cold host. Keep one bounded
    // window, aligned with the existing worker request limit; do not retry.
    return createClientForEntry(entry, cwd, { stdio: spec => buildStdio({ ...spec, handshakeTimeoutMs: 30_000 }) });
  };
  // The CLI composition explicitly supplies this same stock factory. A custom
  // injected client retains its original lifecycle and connection policy.
  const open = clientFor === undefined || clientFor === createClientForEntry ? defaultClientFor : clientFor;

  return (entry, cwd) => {
    const opened = open(entry, cwd);
    if (entry.name !== serverName && entry.name !== HERMES_LEGACY_SERVER_NAME || !opened.ok) return opened;

    // The native skill overlay replaces only the legacy skill surface. Its
    // Memory/session tools keep their original client, schemas and permissions.
    const accepts = entry.name === serverName ? (name: string) => allowed.has(name)
      : (name: string) => !isLegacyHermesSkillTool(name);
    const client = opened.client;
    const guarded: McpStdioClient = {
      ...client,
      async listTools() {
        const listed = await client.listTools();
        return listed.ok ? { ok: true, value: listed.value.filter(tool => accepts(tool.qualifiedName)) } : listed;
      },
      async callTool(request) {
        if (!accepts(request.qualifiedName)) {
          return { ok: false, code: "unknown_tool", detail: "tool is outside the Hermes runtime profile" };
        }

        const result = await client.callTool(request);
        if (entry.name === serverName && observer !== undefined && result.ok && result.outcome.outcome === "result" && isCompleteHermesViewOutput(result.outcome)) {
          const name = hermesSkillReadName({ name: request.qualifiedName, arguments: request.arguments }, result.outcome.output, profile.name);
          if (name !== undefined) {
            try { await observer.viewed({ name }, request.signal); }
            catch { observer.warn("hermes_skill_usage_unavailable"); /* Telemetry never rewrites the foreground read result. */ }
          }

          const receipt = skillProposalReceipt({ name: request.qualifiedName, arguments: request.arguments }, result.outcome.output);
          if (receipt !== undefined && observer.staged !== undefined) {
            try { await observer.staged(receipt, request.signal); }
            catch { observer.warn("hermes_skill_staging_observation_unavailable"); }
          }
        }

        return result;
      },
    };

    return { ...opened, client: guarded };
  };
}
