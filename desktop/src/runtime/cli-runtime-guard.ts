// Trylo Desktop — pre-spawn CLI runtime guard (Round-3 P1-10).
//
// The self-check only ever verified that a FILE EXISTS. The audit P0 it
// missed is the live one: settings said `legacy-stream-json` while the
// configured path named the NEW cli, every check stayed green, and the run
// died at spawn with `unknown command: -p`.
//
// This module asks the binary what it is (the read-only `--version` /
// `--help` probe that already exists) BEFORE the controller hands it a
// prompt, and routes the answer through the tested `selectCliRuntime`
// decision. One placement in `CodeRunController.run` covers Code, Work,
// remote and team sends — they all funnel through there.
//
// Verdict discipline:
//   - PROVEN wrong (kind mismatch) or missing (not_found) → BLOCK. Spawning
//     would fail identically, only later and more cryptically.
//   - DOUBT (timeout / spawn_failed / unrecognized) → PROCEED. The spawn
//     itself stays the final arbiter, as today — a slow disk must not
//     wedge the composer.
// Results are memoized per entry (5 min TTL) so the steady state costs
// nothing: the answer cannot change while the app runs, except when the
// user edits the path — which is a new key.

import { probeCliRuntimeKind } from '../host-adapter/cli-runtime-probe';
import type { CliRuntimeProbeResult } from '../host-adapter/cli-runtime-adapter';
import {
  selectCliRuntime,
  type CliRuntimeSelectionInput,
} from '../host-adapter/cli-runtime-resolution';
import { effectiveV1CliPath } from '../host-adapter/cli-runtime-path';
import { getCliRuntimeResolution } from './cli-runtime-resolution';
import type { CliRuntimeKind } from '../host-adapter/cli-runtime-adapter';
import type { CliRuntimeProtocol } from './cli-runtime-protocol';

export type CliRuntimeGuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface VerifyCliRuntimeInput {
  readonly protocol: CliRuntimeProtocol;
  readonly entryScript: string;
  readonly nodeProgram?: string;
  readonly timeoutMs?: number;
  readonly requiredFlags?: readonly string[];
  readonly now?: () => number;
  /** Test seam. Defaults to the real read-only probe. */
  readonly probe?: (args: {
    readonly entryScript: string;
    readonly preferredProbe?: 'help' | 'version';
    readonly nodeProgram?: string;
    readonly timeoutMs?: number;
  }) => Promise<CliRuntimeProbeResult>;
}

const KIND_FOR_PROTOCOL: Record<CliRuntimeProtocol, CliRuntimeKind> = {
  'legacy-stream-json': 'legacy',
  'trylo-v1': 'trylo-v1',
};

/** How long a verdict stays trusted (re-probe afterwards, never spawn-storm). */
const GUARD_CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { readonly at: number; readonly verdict: CliRuntimeGuardVerdict }>();
const inflight = new Map<string, Promise<CliRuntimeGuardVerdict>>();

function cacheKey(kind: CliRuntimeKind, entryScript: string, nodeProgram?: string): string {
  return `${kind}::${entryScript.trim()}::${(nodeProgram ?? '').trim()}`;
}

/** Test seam: forget memoized verdicts. */
export function resetCliRuntimeGuardForTests(): void {
  cache.clear();
  inflight.clear();
}

function messageFor(kind: CliRuntimeKind, code: string, detail: string): string {
  switch (code) {
    case 'runtime_mismatch':
      return `CLI 自检不通过：当前要用 ${kind} 协议启动，但该文件自称是别的运行时（${detail}）。换一条 CLI 路径，或在设置里切换协议后再试。`;
    case 'entry_missing':
      return `CLI 自检不通过：找不到可执行的 CLI（${detail}）。检查设置里的 CLI 路径。`;
    case 'missing_node_program':
      return `CLI 自检不通过：新 CLI 需要配套的 Node 解释器（${detail}）。重新安装或在设置里修复 CLI 路径。`;
    default:
      return `CLI 自检不通过：${detail}`;
  }
}

export async function verifyCliRuntime(
  input: VerifyCliRuntimeInput,
): Promise<CliRuntimeGuardVerdict> {
  const now = input.now ?? Date.now;
  const kind = KIND_FOR_PROTOCOL[input.protocol];
  const entry = input.entryScript.trim();
  if (entry === '') {
    return { ok: false, message: 'CLI 自检不通过：没有配置 CLI 路径。先在设置里填好再发送。' };
  }
  const key = cacheKey(kind, entry, input.nodeProgram) + JSON.stringify(input.requiredFlags ?? []);
  const cached = cache.get(key);
  if (cached && now() - cached.at < GUARD_CACHE_TTL_MS) return cached.verdict;
  const running = inflight.get(key);
  if (running) return running;
  const probe = input.probe ?? probeCliRuntimeKind;
  const task = (async (): Promise<CliRuntimeGuardVerdict> => {
    // Probe the binary that will actually spawn: for trylo-v1 a placeholder
    // configured path is substituted by the resource resolver, and probing
    // the placeholder would block every default install with `not_found`.
    // Legacy never substitutes — the configured value IS the runtime.
    const resolution = getCliRuntimeResolution();
    const effective = kind === 'trylo-v1'
      ? effectiveV1CliPath(entry, resolution).path
      : entry;
    const probed = await probe({
      entryScript: effective,
      ...(kind === 'trylo-v1' ? { preferredProbe: 'help' as const } : {}),
      ...(input.nodeProgram ? { nodeProgram: input.nodeProgram } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    const selectionInput: CliRuntimeSelectionInput = {
      kind,
      configuredPath: entry,
      resourceResolution: input.nodeProgram ? {
        cliScript: resolution?.cliScript ?? null,
        cliSource: resolution?.cliSource ?? null,
        ...resolution,
        nodeProgram: input.nodeProgram,
        nodeSource: resolution?.nodeSource ?? 'env',
      } : resolution,
      probe: probed,
      requireProbe: true,
    };
    const selected = selectCliRuntime(selectionInput);
    if (selected.ok !== false) {
      if (probed.ok && probed.kind === 'trylo-v1' && probed.supportedFlags) {
        const missing = input.requiredFlags?.filter(flag => !probed.supportedFlags!.includes(flag)) ?? [];
        if (missing.length) return { ok: false, message: `当前 CLI 构建不支持 ${missing.join('、')}。请在 new trylo cli 运行 npm run build 后重试；自定义 CLI 路径请指向支持这些选项的版本。` };
      }
      return { ok: true };
    }
    // Block on proof (wrong kind, missing entry, missing interpreter).
    // Anything else (timeout / spawn failure / unrecognized banner) is
    // doubt, not proof — the spawn itself stays the arbiter, as today.
    if (
      selected.code === 'runtime_mismatch'
      || selected.code === 'entry_missing'
      || selected.code === 'missing_node_program'
    ) {
      return { ok: false, message: messageFor(kind, selected.code, selected.detail) };
    }
    return { ok: true };
  })();
  inflight.set(key, task);
  try {
    const verdict = await task;
    cache.set(key, { at: now(), verdict });
    return verdict;
  } finally {
    inflight.delete(key);
  }
}
