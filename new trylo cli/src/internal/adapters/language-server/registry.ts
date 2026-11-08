/**
 * Which language server answers, and whether it is allowed to start.
 *
 * Reused from the legacy CLI's `services/lsp/LSPServerManager.ts` +
 * `config.ts` (~500 lines) in shape only. The mechanics worth keeping are the
 * two that were got right there: a server is matched by **file extension** rather
 * than by "whatever was connected first", and a project gets its own set rather
 * than the process-wide set. The rest was not portable and is not here:
 *
 *   - configuration came from the plugin system, which Trylo does not have;
 *   - the manager was a module-level singleton with its own init state machine
 *     and its own shutdown. Trylo has exactly one owner per lifecycle, and a
 *     hidden singleton that starts servers during CLI startup is precisely the
 *     thing the cost contract forbids — a plain `trylo` run must not spawn a
 *     language server.
 *
 * So the registry is inert: it *describes* which server would serve a project
 * and does not start anything. Starting is the client's business, and starting is
 * gated on authorization, because running a program is a side effect even when
 * the question being answered is read-only.
 */

import type { LspFailure, LanguageServerRegistry, LspServerSpec } from "../../ports/language-server.js";
import { DEFAULT_LSP_LIMITS, type LspLimits } from "../../ports/language-server.js";
import { extensionOf } from "./lsp-extension.js";
import { createLanguageServer, type CreateLanguageServerOptions, type LspProcessDeps } from "./client.js";
import { withQueryLimits } from "./lsp-limits.js";
import type { LanguageServerPort } from "../../ports/language-server.js";

/**
 * One configured server. `extensions` is what routes a file to it; an empty
 * list means "declares capabilities but is not auto-selected", which is how a
 * user registers a server for a language Trylo has no extension mapping for
 * without it silently taking over every query.
 */
export type LspServerConfig = {
  readonly serverName: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Lower-case, no dot: `ts`, `tsx`, `py`. */
  readonly extensions: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  /** Shown when the executable is missing, so the message can be actionable. */
  readonly origin?: string;
  readonly enabled?: boolean;
};

export type LspRegistryOptions = {
  readonly servers: ReadonlyArray<LspServerConfig>;
  readonly deps: LspProcessDeps;
  readonly limits?: LspLimits;
  /**
   * Overridable so a test can start a server that is not a real language
   * server. Production leaves it alone.
   */
  readonly createServer?: (options: CreateLanguageServerOptions) => LanguageServerPort;
  /** Told whenever a server is released, so the owner can account for it. */
  readonly onReleased?: (serverName: string) => void;
};

/**
 * The pool. One instance per process, owned by whoever wired the CLI — not a
 * module-level singleton, because the thing that has to be true is "exactly one
 * owner", and an owner you cannot inject is not one.
 *
 * Identity is `(serverName, workspaceRoot)`. That pairing is the whole reuse
 * rule: a language server's index is per-project, so two projects asking for
 * `typescript` must get two connections, and the same project asking twice must
 * not get two.
 */
export class LanguageServerPool implements LanguageServerRegistry {
  private readonly connections = new Map<string, LanguageServerPort>();

  constructor(private readonly options: LspRegistryOptions) {}

  configured(): ReadonlyArray<LspServerSpec> {
    return this.options.servers.filter(isEnabled).map((server) => ({
      serverName: server.serverName,
      workspaceRoot: "",
      command: server.command,
      args: server.args,
      ...(server.env === undefined ? {} : { env: server.env }),
      ...(server.origin === undefined ? {} : { origin: server.origin }),
    }));
  }

  /**
   * The server for a file, by extension alone. Refuses rather than guessing when
   * nothing matches or when two servers claim the same extension — a silent pick
   * would answer TypeScript questions with a Python server's idea of the file.
   *
   * No project argument: routing is a property of the file, and the project
   * enters when the connection is keyed. Keeping them separate is what stops a
   * per-project index from being shared across projects.
   */
  resolveForFile(path: string): LspFailure | { readonly ok: true; readonly spec: LspServerConfig } {
    const extension = extensionOf(path);
    if (extension === undefined) {
      return { ok: false, code: "lsp_not_configured", message: `no language server matches ${path}: it has no recognised extension` };
    }

    const candidates = this.options.servers.filter((server) => isEnabled(server) && server.extensions.includes(extension));
    if (candidates.length === 0) {
      return {
        ok: false,
        code: "lsp_not_configured",
        message: `no language server configured for .${extension} files; add one to your LSP settings`,
      };
    }

    if (candidates.length > 1) {
      return {
        ok: false,
        code: "lsp_not_configured",
        message: `language servers ${candidates.map((c) => c.serverName).join(", ")} all claim .${extension}; configure exactly one`,
      };
    }

    const server = candidates[0];
    if (server === undefined) {
      // Unreachable given the length check; kept so a future filter change cannot
      // turn into an unchecked undefined reaching the spawn call.
      return { ok: false, code: "lsp_not_configured", message: `no language server configured for .${extension}` };
    }

    // No workspaceRoot here: a config entry describes a *program*, and the root
    // is what the caller is standing in. Conflating them is how one project's
    // index ends up answering about another.
    return { ok: true, spec: server };
  }

  /** Port-facing view: identity-only, so a caller cannot route by file here. */
  resolveFor(workspaceRoot: string): LspFailure | { readonly ok: true; readonly spec: LspServerSpec } {
    const enabled = this.options.servers.filter(isEnabled);
    if (enabled.length === 0) {
      return {
        ok: false,
        code: "lsp_not_configured",
        message: "no language servers configured; navigation falls back to text search",
      };
    }

    const first = enabled[0];
    if (first === undefined) {
      return { ok: false, code: "lsp_not_configured", message: "no language servers configured" };
    }

    return {
      ok: true,
      spec: {
        serverName: first.serverName,
        workspaceRoot,
        command: first.command,
        args: first.args,
        ...(first.env === undefined ? {} : { env: first.env }),
        ...(first.origin === undefined ? {} : { origin: first.origin }),
      },
    };
  }

  /**
   * The connection for a file, started if needed. This is the only place a
   * language server process comes into existence.
   */
  async connectionFor(workspaceRoot: string, path: string, preload?: CreateLanguageServerOptions["preloadDocuments"]): Promise<LspFailure | { readonly ok: true; readonly port: LanguageServerPort }> {
    const resolved = this.resolveForFile(path);
    if (!resolved.ok) {
      return resolved;
    }

    const key = connectionKey(resolved.spec.serverName, workspaceRoot);
    const existing = this.connections.get(key);
    if (existing !== undefined) {
      return { ok: true, port: existing };
    }

    if (this.connections.size >= (this.options.limits ?? DEFAULT_LSP_LIMITS).maxServers) {
      return {
        ok: false,
        code: "lsp_limit_exceeded",
        message: `already holding ${this.connections.size} language servers, the configured maximum; close one before starting another`,
      };
    }

    const factory = this.options.createServer ?? createLanguageServer;
    const port = factory({
      spec: {
        serverName: resolved.spec.serverName,
        workspaceRoot,
        command: resolved.spec.command,
        args: resolved.spec.args,
        ...(resolved.spec.env === undefined ? {} : { env: resolved.spec.env }),
        ...(resolved.spec.origin === undefined ? {} : { origin: resolved.spec.origin }),
      },
      ...(this.options.limits === undefined ? {} : { limits: this.options.limits }),
      deps: this.options.deps,
      ...(preload === undefined ? {} : { preloadDocuments: preload }),
    });
    // Ceilings belong to the pool, not to each caller: every consumer of this
    // connection — the tool today, anyone tomorrow — shares one enforcement.
    const limited = withQueryLimits(port, this.options.limits ?? DEFAULT_LSP_LIMITS);

    this.connections.set(key, limited);

    return { ok: true, port: limited };
  }

  /** Running servers, for `doctor` and for the cost report. */
  running(): ReadonlyArray<string> {
    return [...this.connections.entries()].filter(([, port]) => port.isRunning()).map(([key]) => key);
  }

  /** Release everything. The owner calls this at session end, not module unload. */
  async closeAll(): Promise<void> {
    const entries = [...this.connections.entries()];

    this.connections.clear();

    for (const [key, port] of entries) {
      try {
        await port.close();
      } catch (error) {
        // Teardown of every remaining server still happens; one stubborn
        // connection must not strand the others as child processes.
        this.options.deps.log({ serverName: key, phase: "closed", detail: error instanceof Error ? error.message : String(error) });
      }
      this.options.onReleased?.(key);
    }
  }
}

export function connectionKey(serverName: string, workspaceRoot: string): string {
  return `${serverName}::${workspaceRoot}`;
}

function isEnabled(server: LspServerConfig): boolean {
  return server.enabled !== false;
}

/**
 * The only programs a language server start may run.
 *
 * Exact string equality with a configured, enabled server's command — a bare
 * name matches only the same bare name, an absolute path only the same path.
 * Anything looser (prefix, basename, PATH search) would let a tool argument
 * smuggle a neighbouring program past the configuration, which is exactly
 * what `needsApproval: false` must never allow: the model chooses the
 * question, never what executes.
 */
export function mayStartCommand(servers: ReadonlyArray<LspServerConfig>, command: string): boolean {
  return servers.some((server) => isEnabled(server) && server.command === command);
}
