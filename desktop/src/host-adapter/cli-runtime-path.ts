// Trylo Desktop — CLI path resolution (P08 §WP6).
//
// The renderer must never hard-code a developer's absolute path. It asks
// the Rust resource resolver, and the answer may legitimately be "not
// found" — which has to stay a distinct, visible state rather than
// collapsing into a guessed default.
//
import { invoke } from '@tauri-apps/api/core'

export type CliResolutionSource = 'env' | 'bundled' | 'dev-checkout' | 'system-path'

export interface CliRuntimeResolution {
  /** Absolute path to the CLI script, or null when nothing was found. */
  readonly cliScript: string | null
  readonly cliSource: CliResolutionSource | null
  readonly nodeProgram: string
  readonly nodeSource: CliResolutionSource
}

/** Ask Rust where the CLI lives. Throws only if the IPC itself fails. */
export async function resolveCliRuntime(): Promise<CliRuntimeResolution> {
  const dto = await invoke<{
    cli_script: string | null
    cli_source: string | null
    node_program: string
    node_source: string
  }>('resolve_cli_runtime')
  return {
    cliScript: dto.cli_script,
    cliSource: (dto.cli_source as CliResolutionSource | null) ?? null,
    nodeProgram: dto.node_program,
    nodeSource: dto.node_source as CliResolutionSource,
  }
}

/** A sentence for the settings screen / diagnostics. */
export function describeCliResolution(resolution: CliRuntimeResolution): string {
  if (!resolution.cliScript) {
    return '未找到新 CLI。开发态请先构建 CLI（dist/），发行版请确认打包资源包含 cli/。'
  }
  const source =
    resolution.cliSource === 'bundled'
      ? '打包资源'
      : resolution.cliSource === 'dev-checkout'
        ? '开发 checkout'
        : resolution.cliSource === 'env'
          ? '环境变量覆盖'
          : '未知来源'
  return `新 CLI：${source}（Node：${resolution.nodeSource}）`
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
  readonly command: string
  readonly prefix: readonly string[]
}

/** Tauri can return verbatim Windows resource paths. Node's entry resolver
 * treats the verbatim drive prefix as a directory and exits before main.js.
 * Convert only filesystem script paths, retaining UNC host/share semantics.
 */
function nodeScriptArgument(script: string): string {
  if (/^\\\\\?\\[a-z]:\\/i.test(script)) return script.slice(4)
  if (/^\\\\\?\\UNC\\/i.test(script)) return `\\\\${script.slice(8)}`
  return script
}

export function cliSpawnCommand(cliScript: string, nodeProgram?: string | null): CliSpawnCommand {
  const isNodeScript = /\.(m?js|cjs)$/i.test(cliScript)
  if (!isNodeScript) return { command: cliScript, prefix: [] }
  const node = (nodeProgram ?? '').trim()
  // Falling back to bare `node` keeps the dev loop working; the resolver
  // reports `system-path` when that happens, so a packaged build that
  // silently relied on PATH is visible in diagnostics.
  return { command: node !== '' ? node : 'node', prefix: [nodeScriptArgument(cliScript)] }
}
