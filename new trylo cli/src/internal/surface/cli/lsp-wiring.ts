/**
 * Building the language-server pool for a run (WP12 L60).
 *
 * Split out of `wiring.ts` under that file's size gate. The pool is built
 * here and nowhere else so the tools that ask questions and the processes
 * that answer them stay one object: a pool constructed inside the catalog
 * would be a second owner of the same servers.
 */

import { hostProcessEnvironment } from "../../adapters/sandbox/executable.js";
import type { LspLogEvent, LspProcessDeps } from "../../adapters/language-server/client.js";
import { LanguageServerPool, mayStartCommand, type LspServerConfig } from "../../adapters/language-server/registry.js";

export const LSP_EVENT_RING_LIMIT = 100;

export type LspWiring = {
  readonly pool: LanguageServerPool;
  /** Lifecycle facts, newest last, bounded. Currently unread; kept for future doctor wiring. */
  readonly events: Array<LspLogEvent>;
};

/**
 * The start gate for a run's pool, as the client expects it. A separate
 * function so the one line that matters — allow exactly what the validated
 * configuration named — is directly assertable without starting a process.
 */
export function lspAuthorizer(servers: ReadonlyArray<LspServerConfig>): LspProcessDeps["authorize"] {
  return async (command) =>
    mayStartCommand(servers, command)
      ? { ok: true }
      : { ok: false, code: "lsp_start_denied", message: `${command} is not a configured language server` };
}

/**
 * Undefined in, undefined out: no configured servers means no pool, no tool,
 * no process, and a byte-identical catalog. The host environment comes from
 * the layer's acknowledged owner, never from a direct read here.
 */
export function buildLspPool(servers: ReadonlyArray<LspServerConfig> | undefined): LspWiring | undefined {
  if (servers === undefined) {
    return undefined;
  }

  const events: Array<LspLogEvent> = [];
  const pool = new LanguageServerPool({
    servers,
    deps: {
      authorize: lspAuthorizer(servers),
      hostEnv: hostProcessEnvironment(),

      log: (event) => {
        events.push(event);
        if (events.length > LSP_EVENT_RING_LIMIT) {
          events.shift();
        }
      },
    },
  });

  return { pool, events };
}

/**
 * The catalog patch for `createWorkspaceTools`: the pool, or nothing.
 * One line at the call site instead of a build plus a conditional spread,
 * so the composition root stays under its own size gate.
 */
export function lspToolsPatch(input: { readonly languageServers?: ReadonlyArray<LspServerConfig> }): {
  readonly languageServers?: LanguageServerPool;
} {
  const built = buildLspPool(input.languageServers);
  return built === undefined ? {} : { languageServers: built.pool };
}
