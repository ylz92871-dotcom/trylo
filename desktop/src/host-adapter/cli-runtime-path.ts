// Trylo Desktop — CLI path resolution (P08 §WP6).
//
// The renderer must never hard-code a developer's absolute path. It asks
// the Rust resource resolver, and the answer may legitimately be "not
// found" — which has to stay a distinct, visible state rather than
// collapsing into a guessed default.
//
// Migration is ADDITIVE (§12: 「任何迁移都必须是 additive」): a path the
// user configured themselves is never overwritten. Only two cases move:
//   - empty (never configured),
//   - the known hard-coded development default, which is a bug for
//     anyone who is not the machine it was written on.

import { invoke } from '@tauri-apps/api/core';
import { isLegacyRuntimeDefaultCliPath } from '../runtime/cli-runtime-path-defaults';

/**
 * A historical `DEFAULTS.cliPath`: the OLD runtime's entry.
 *
 * Read the name carefully. This is not "a stale developer path" in the
 * abstract — it is the *legacy* CLI. It is a perfectly good value for a
 * `legacy-stream-json` run and a wrong one for a `trylo-v1` run, which
 * is why `effectiveV1CliPath` (below) and `settingsForCodeRun` must
 * never be called for the legacy protocol with this value in hand.
 *
 * (The first cut of this file got that exactly wrong: it replaced this
 * value unconditionally, so a default legacy run was pointed at the new
 * CLI and then handed `-p --input-format …`, which the new CLI rejects
 * with `unknown command: -p`. See the P08 audit, P0.)
 */
export { LEGACY_RUNTIME_DEFAULT_CLI_PATH } from '../runtime/cli-runtime-path-defaults';

export type CliResolutionSource = 'env' | 'bundled' | 'dev-checkout' | 'system-path';

export interface CliRuntimeResolution {
  /** Absolute path to the CLI script, or null when nothing was found. */
  readonly cliScript: string | null;
  readonly legacyCliScript?: string | null;
  readonly legacyCliSource?: CliResolutionSource | null;
  readonly cliSource: CliResolutionSource | null;
  readonly nodeProgram: string;
  readonly nodeSource: CliResolutionSource;
}

/** Ask Rust where the CLI lives. Throws only if the IPC itself fails. */
export async function resolveCliRuntime(): Promise<CliRuntimeResolution> {
  const dto = await invoke<{
    cli_script: string | null;
    legacy_cli_script?: string | null;
    legacy_cli_source?: string | null;
    cli_source: string | null;
    node_program: string;
    node_source: string;
  }>('resolve_cli_runtime');
  return {
    cliScript: dto.cli_script,
    legacyCliScript: dto.legacy_cli_script ?? null,
    legacyCliSource: (dto.legacy_cli_source as CliResolutionSource | null) ?? null,
    cliSource: (dto.cli_source as CliResolutionSource | null) ?? null,
    nodeProgram: dto.node_program,
    nodeSource: dto.node_source as CliResolutionSource,
  };
}

/** What the run should actually use, given what the user configured. */
export interface EffectiveCliPath {
  readonly path: string;
  /**
   * True when the configured value could not be used as-is. The UI should
   * say so — silently running a different CLI than the settings screen
   * shows is worse than an honest notice.
   */
  readonly substituted: boolean;
}

/**
 * Decide the CLI path for a **trylo-v1** run.
 *
 * MUST NOT be called for `legacy-stream-json`: the legacy protocol talks
 * to the old CLI, and the whole point of the default is that switching
 * the protocol is what changes the runtime — not the mere presence of a
 * resolved path. `settingsForCodeRun` owns that branch; if you find
 * yourself calling this without checking the protocol, stop.
 *
 * A user-set path wins, always. The only substitutions are "nothing
 * configured" and the legacy runtime's own default (which cannot run the
 * v1 protocol), and both need the resolver to have an answer — with no
 * answer we keep what we had, so the failure surfaces as "CLI not found
 * at <their path>" rather than as an empty string downstream.
 */
export function effectiveV1CliPath(
  configured: string | undefined,
  resolved: CliRuntimeResolution | null,
): EffectiveCliPath {
  const trimmed = (configured ?? '').trim();
  const isLegacyDefault = isLegacyRuntimeDefaultCliPath(trimmed);
  if (trimmed !== '' && !isLegacyDefault) {
    return { path: trimmed, substituted: false };
  }
  if (resolved?.cliScript) {
    return { path: resolved.cliScript, substituted: true };
  }
  return { path: trimmed, substituted: false };
}

/** A sentence for the settings screen / diagnostics. */
export function describeCliResolution(resolution: CliRuntimeResolution): string {
  if (!resolution.cliScript) {
    return '未找到新 CLI。开发态请先构建 CLI（dist/），发行版请确认打包资源包含 cli/。';
  }
  const source =
    resolution.cliSource === 'bundled'
      ? '打包资源'
      : resolution.cliSource === 'dev-checkout'
        ? '开发 checkout'
        : resolution.cliSource === 'env'
          ? '环境变量覆盖'
          : '未知来源';
  return `新 CLI：${source}（Node：${resolution.nodeSource}）`;
}

/**
 * The `command` + argv prefix every v1 spawn must use.
 *
 * ONE place decides "run this script with that interpreter". Before this,
 * three modules each re-implemented the `/\.(m?js|cjs)$/` test and then
 * hard-coded plain `node` — so a machine with no Node on PATH failed even
 * though the app ships a pinned one and had already resolved its path.
 *
 * `nodeProgram` comes from the same resolution as `cliScript`; they are
 * not independent, which is why callers pass both or neither.
 */
export interface CliSpawnCommand {
  readonly command: string;
  readonly prefix: readonly string[];
}

/** Tauri can return verbatim Windows resource paths. Node's entry resolver
 * treats the verbatim drive prefix as a directory and exits before main.js.
 * Convert only filesystem script paths, retaining UNC host/share semantics.
 */
function nodeScriptArgument(script: string): string {
  if (/^\\\\\?\\[a-z]:\\/i.test(script)) return script.slice(4);
  if (/^\\\\\?\\UNC\\/i.test(script)) return `\\\\${script.slice(8)}`;
  return script;
}

export function cliSpawnCommand(
  cliScript: string,
  nodeProgram?: string | null,
): CliSpawnCommand {
  const isNodeScript = /\.(m?js|cjs)$/i.test(cliScript);
  if (!isNodeScript) return { command: cliScript, prefix: [] };
  const node = (nodeProgram ?? '').trim();
  // Falling back to bare `node` keeps the dev loop working; the resolver
  // reports `system-path` when that happens, so a packaged build that
  // silently relied on PATH is visible in diagnostics.
  return { command: node !== '' ? node : 'node', prefix: [nodeScriptArgument(cliScript)] };
}

/** Resolve only the legacy entry; a discovered v1 entry can never substitute it. */
export function effectiveLegacyCliPath(
  configured: string | undefined,
  resolved: CliRuntimeResolution | null,
): EffectiveCliPath {
  const trimmed = (configured ?? '').trim();
  const isOldDefault = isLegacyRuntimeDefaultCliPath(trimmed);
  if (trimmed !== '' && !isOldDefault) return { path: trimmed, substituted: false };
  return resolved?.legacyCliScript
    ? { path: resolved.legacyCliScript, substituted: true }
    : { path: trimmed, substituted: false };
}
