// Validate the exact new CLI entry before delivering a prompt.
import { probeCliRuntimeKind } from '../host-adapter/cli-runtime-probe'
import type { CliRuntimeProbeResult } from '../host-adapter/cli-runtime-probe-types'
export type CliRuntimeGuardVerdict =
  { readonly ok: true } | { readonly ok: false; readonly message: string }
export interface VerifyCliRuntimeInput {
  readonly entryScript: string
  readonly nodeProgram?: string
  readonly timeoutMs?: number
  readonly requiredFlags?: readonly string[]
  readonly now?: () => number
  readonly probe?: (args: {
    readonly entryScript: string
    readonly preferredProbe?: 'help' | 'version'
    readonly nodeProgram?: string
    readonly timeoutMs?: number
  }) => Promise<CliRuntimeProbeResult>
}
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { readonly at: number; readonly verdict: CliRuntimeGuardVerdict }>()
const inflight = new Map<string, Promise<CliRuntimeGuardVerdict>>()
export function resetCliRuntimeGuardForTests(): void {
  cache.clear()
  inflight.clear()
}
export async function verifyCliRuntime(
  input: VerifyCliRuntimeInput,
): Promise<CliRuntimeGuardVerdict> {
  const entry = input.entryScript.trim()
  if (!entry) return { ok: false, message: '未找到新版 Trylo CLI，请检查开发构建或重新安装应用。' }
  const now = input.now ?? Date.now
  const key = JSON.stringify([entry, input.nodeProgram, input.requiredFlags])
  const previous = cache.get(key)
  if (previous && now() - previous.at < CACHE_TTL_MS) return previous.verdict
  const running = inflight.get(key)
  if (running) return running
  const task = (async (): Promise<CliRuntimeGuardVerdict> => {
    const result = await (input.probe ?? probeCliRuntimeKind)({
      entryScript: entry,
      preferredProbe: 'help',
      ...(input.nodeProgram ? { nodeProgram: input.nodeProgram } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
    if (!result.ok) {
      if (result.code === 'incompatible' || result.code === 'not_found')
        return {
          ok: false,
          message: '新版 Trylo CLI 自检失败：' + result.detail + '。请检查构建或安装资源。',
        }
      // An unanswered probe is uncertainty; the real spawn remains authoritative.
      return { ok: true }
    }
    const missing = result.supportedFlags
      ? (input.requiredFlags?.filter((flag) => !result.supportedFlags!.includes(flag)) ?? [])
      : []
    return missing.length
      ? {
          ok: false,
          message: '当前新版 CLI 构建不支持 ' + missing.join('、') + '，请重新构建 CLI。',
        }
      : { ok: true }
  })()
  inflight.set(key, task)
  try {
    const verdict = await task
    cache.set(key, { at: now(), verdict })
    return verdict
  } finally {
    inflight.delete(key)
  }
}
