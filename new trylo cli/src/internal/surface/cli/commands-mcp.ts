import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { McpAddCommandOptions, McpTargetOptions } from "./args-mcp.js";
import type { CliContext } from "./context.js";
import { createCliMcpRegistry, mcpRegistryExitCode, openMcpStatusPool } from "./mcp-wiring.js";
import { reportFailure } from "./run-failure.js";
import { publicRegistryDiagnostic, registryDiagnosticWarning } from "../../adapters/mcp-registry/diagnostics.js";

/**
 * `trylo mcp` handlers.
 *
 * This is management of *configuration*, not of processes: nothing here starts a
 * server, resolves a binary or dials a transport. An `add` records the command a
 * user asked Trylo to be able to run later, and a command whose binary does not
 * exist is still a legal entry — the failure belongs at connect time, where it
 * can be reported honestly rather than guessed at here.
 *
 * Two rules shape the output:
 *
 *  - **Env values never print.** `list` shows `envKeys` only, because a listing
 *    is the most likely thing to be pasted into a bug report.
 *  - **A broken registry is not an empty registry.** Independently verified
 *    runtime entries may be listed as partial, with the base failure retained
 *    in the exit code. Management never repairs or replaces the broken file.
 */

type McpHandlerContext = CliContext;

function refuse(
  ctx: McpHandlerContext,
  code: Parameters<typeof mcpRegistryExitCode>[0],
  detail: string,
  hint: string,
): ExitCode {
  return reportFailure(ctx, { exitCode: mcpRegistryExitCode(code), message: detail, hint });
}

export async function handleMcpAdd(
  ctx: McpHandlerContext,
  options: McpAddCommandOptions,
): Promise<ExitCode> {
  const registry = createCliMcpRegistry(ctx);
  const added = await registry.add({
    name: options.name,
    transport: options.transport,
    command: options.command,
    args: options.args,
    env: options.env,
    enabled: options.enabled,
    scope: options.scope,
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  if (!added.ok) {
    return refuse(
      ctx,
      added.code,
      added.detail,
      "a server is registered per scope; `trylo mcp list` shows what is already there",
    );
  }

  ctx.stdout(`${addSummary(options.scope, added.value)}\n`);

  return EXIT_CODES.OK;
}

/** One line per added server. Header and env *values* never appear here. */
function addSummary(scope: string, entry: { readonly name: string; readonly transport: string; readonly command: string; readonly args: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>>; readonly url?: string; readonly headers?: Readonly<Record<string, string>>; readonly enabled: boolean }): string {
  if (entry.transport === "stdio") {
    const env = Object.keys(entry.env).sort();
    const envSuffix = env.length === 0 ? "" : ` env=[${env.join(",")}]`;
    return `added ${entry.name} to the ${scope} registry: ${entry.command} ${entry.args.join(" ")}${envSuffix} (${entry.enabled ? "enabled" : "disabled"})`;
  }

  const headers = Object.keys(entry.headers ?? {}).sort();
  const headerSuffix = headers.length === 0 ? "" : ` headers=[${headers.join(",")}]`;

  return `added ${entry.name} to the ${scope} registry: ${entry.transport} ${entry.url ?? ""}${headerSuffix} (${entry.enabled ? "enabled" : "disabled"})`;
}

export async function handleMcpList(ctx: McpHandlerContext, json: boolean): Promise<ExitCode> {
  const registry = createCliMcpRegistry(ctx);
  const merged = await registry.list();
  if (!merged.ok) {
    return refuse(
      ctx,
      merged.code,
      `${merged.code}: ${merged.detail}`,
      "fix or remove that registry file; a registry that cannot be read is never reported as empty",
    );
  }

  const diagnostics = merged.diagnostics ?? [];
  for (const diagnostic of diagnostics) ctx.stderr(`warning: ${registryDiagnosticWarning(diagnostic)}\n`);
  const partialExit = diagnostics[0] ? mcpRegistryExitCode(diagnostics[0].code) : EXIT_CODES.OK;

  const rows: Array<{
    readonly name: string;
    readonly transport: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly envKeys: ReadonlyArray<string>;
    readonly enabled: boolean;
    readonly scopes: ReadonlyArray<string>;
    readonly effectiveScope: string;
    readonly shadowedScopes: ReadonlyArray<string>;
    readonly url?: string;
    readonly headerKeys: ReadonlyArray<string>;
  }> = [];

  for (const server of merged.value.servers) {
    const effective = await registry.resolve(server.name);
    const effectiveScope = effective.ok ? effective.value.scope : "unknown";

    rows.push({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      envKeys: server.envKeys,
      enabled: server.enabled,
      scopes: server.scopes,
      effectiveScope,
      shadowedScopes: effective.ok ? effective.value.shadowedScopes : [],
      ...(server.url === undefined ? {} : { url: server.url }),
      headerKeys: server.headerKeys,
    });
  }

  if (json) {
    ctx.stdout(`${JSON.stringify({ formatVersion: merged.value.formatVersion, servers: rows,
      ...(diagnostics.length === 0 ? {} : { partial: true, diagnostics: diagnostics.map(publicRegistryDiagnostic) }) })}\n`);
    return partialExit;
  }

  if (rows.length === 0) {
    ctx.stdout("no MCP servers registered; `trylo mcp add <name> -- <command>`\n");
    return partialExit;
  }

  for (const row of rows) {
    ctx.stdout(`${listRow(row)}\n`);
  }

  return partialExit;
}

/** One text row per server. Remote rows show the url; header values never. */
function listRow(row: {
  readonly transport: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly url?: string;
  readonly headerKeys: ReadonlyArray<string>;
  readonly envKeys: ReadonlyArray<string>;
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
  readonly shadowedScopes: ReadonlyArray<string>;
  readonly effectiveScope: string;
  readonly enabled: boolean;
}): string {
  const scopes = row.scopes.join("+");
  const overridden =
    row.shadowedScopes.length === 0 ? "" : ` (${row.effectiveScope} overrides ${row.shadowedScopes.join("+")})`;

  if (row.transport === "stdio") {
    const env = row.envKeys.length === 0 ? "" : ` env=[${row.envKeys.join(",")}]`;
    return `${row.name} ${row.transport} ${row.command} ${row.args.join(" ")} [${scopes}]${overridden} ${row.enabled ? "enabled" : "disabled"}${env}`;
  }

  const headers = row.headerKeys.length === 0 ? "" : ` headers=[${row.headerKeys.join(",")}]`;

  return `${row.name} ${row.transport} ${row.url ?? ""} [${scopes}]${overridden} ${row.enabled ? "enabled" : "disabled"}${headers}`;
}

export async function handleMcpRemove(
  ctx: McpHandlerContext,
  options: McpTargetOptions,
): Promise<ExitCode> {
  const registry = createCliMcpRegistry(ctx);
  const removed = await registry.remove({ name: options.name, scope: options.scope });
  if (!removed.ok) {
    return refuse(
      ctx,
      removed.code,
      removed.detail,
      `only the ${options.scope} registry is touched; pass --scope to target the other one`,
    );
  }

  ctx.stdout(`removed ${removed.value.name} from the ${options.scope} registry\n`);

  return EXIT_CODES.OK;
}

export async function handleMcpSetEnabled(
  ctx: McpHandlerContext,
  options: McpTargetOptions,
  enabled: boolean,
): Promise<ExitCode> {
  const registry = createCliMcpRegistry(ctx);
  const updated = await registry.setEnabled({ name: options.name, scope: options.scope }, enabled);
  if (!updated.ok) {
    return refuse(
      ctx,
      updated.code,
      updated.detail,
      `only the ${options.scope} registry is touched; pass --scope to target the other one`,
    );
  }

  ctx.stdout(`${updated.value.name} is now ${updated.value.enabled ? "enabled" : "disabled"} in the ${options.scope} registry\n`);

  return EXIT_CODES.OK;
}

/**
 * `trylo mcp status`: what a run would actually see.
 *
 * Unlike `list` (registry files only), every enabled server is dialled the
 * way `openMcpPool` dials it for a run — eagerly and fail-soft — so a server
 * whose binary vanished, whose endpoint went dark, or whose headers no
 * longer authenticate shows up as a fact rather than as a configured name.
 * Header *values* never appear here: `headerKeys` carries key names only, and
 * a 401 body is never quoted into a detail line.
 */
export async function handleMcpStatus(ctx: McpHandlerContext, json: boolean): Promise<ExitCode> {
  const pool = await openMcpStatusPool(ctx);
  try {
    const connected = pool.servers.map((server) => ({
      name: server.serverId,
      state: "connected",
      tools: server.tools.length,
    }));
    const failed = pool.failures.map((failure) => ({
      name: failure.serverId,
      state: "unavailable" as const,
      code: failure.code,
      detail: failure.registryDiagnostic ? registryDiagnosticWarning(failure.registryDiagnostic) : failure.detail,
      ...(failure.registryDiagnostic ? { partial: true, registry: publicRegistryDiagnostic(failure.registryDiagnostic) } : {}),
    }));
    const disabled = pool.skipped.map((skipped) => ({ name: skipped.serverId, state: "disabled" as const }));
    const headerKeys = pool.headerKeys.map((entry) => ({ server: entry.serverId, keys: [...entry.keys] }));

    if (json) {
      ctx.stdout(`${JSON.stringify({ connected, failed, disabled, headerKeys })}\n`);
      return EXIT_CODES.OK;
    }

    if (connected.length === 0 && failed.length === 0 && disabled.length === 0) {
      ctx.stdout("no MCP servers registered; `trylo mcp add <name> -- <command>`\n");
      return EXIT_CODES.OK;
    }

    for (const server of connected) {
      ctx.stdout(`${server.name} connected tools=${server.tools}\n`);
    }

    for (const skipped of disabled) {
      ctx.stdout(`${skipped.name} disabled\n`);
    }

    for (const failure of failed) {
      ctx.stdout(`${failure.name === "" ? "(registry)" : failure.name} unavailable:${failure.code} ${failure.detail}\n`);
    }

    for (const entry of headerKeys) {
      ctx.stdout(`${entry.server} headers=[${entry.keys.join(",")}]\n`);
    }

    const needsAuth = failed.filter((failure) => failure.code === "needs_auth" && failure.name !== "");

    for (const failure of needsAuth) {
      ctx.stdout(
        `hint: ${failure.name} answered HTTP 401; re-register it with fresh credentials (` +
          `\`trylo mcp remove ${failure.name}\` then \`trylo mcp add\` with a current --header)\n`,
      );
    }

    return EXIT_CODES.OK;
  } finally {
    await pool.closeAll();
  }
}
