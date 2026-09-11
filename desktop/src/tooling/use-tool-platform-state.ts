// Trylo Desktop — Tool Platform state machine (audit P0-A §3.3).
//
// The renderer-side owner of "what does the user SEE about the four tool
// packages". The Service Host owns the on-disk truth; this hook owns the
// projection contract:
//
//   未安装 → 安装中 → 校验中 → 可用
//                     └→ 安装失败 / 版本漂移 / hash 不符 / 缺少运行条件
//
// Design rules from the audit:
//   1. Service Host ready → call `tooling.health` ONCE; the result enters
//      this store (never settings — §3.3-4: transient health does not
//      persist).
//   2. Install/repair/uninstall go through the EXISTING RPCs; this module
//      adds no installer logic.
//   3. After a successful install: re-run health + re-resolve the Profile;
//      the old tool-less prewarm dies on the next send because its runtime
//      fingerprint no longer matches (code-run-controller adoption contract).
//   4. A playwright package installed without the browser body is NOT
//      "available" — the sidecar health already degrades it to
//      `condition-missing`; this module maps it to the fixed user text.
//
// The state transitions live in PURE functions (`derivePackageView`,
// `reduceActionState`) so the acceptance behaviour is testable without React.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceManager, ServiceHealth } from '../services-host/service-manager';
import { ServiceRequestError } from '../services-host/services-client';
import type {
  ToolPackageHealth,
  ToolingHealthResult,
} from '../services-host/methods';
import type { ToolingFacade } from './tooling-facade';

/** The fixed state machine the settings UI renders (audit §3.3). */
export type ToolPackageUiState =
  | 'unknown'          // no health answer yet
  | 'checking'         // health in flight
  | 'installing'       // install RPC in flight
  | 'verifying'        // install done, health re-check in flight
  | 'installing-browser' // browser-body install in flight (playwright)
  | 'available'        // installed AND every runtime condition ok
  | 'install-failed'   // install RPC failed
  | 'unusable';        // installed but health says not available (drift/condition)

/** Fixed, UI-ready text per failure shape (§3.3: 固定错误文案 — the raw
 *  `detail` may carry absolute paths and is never rendered verbatim). */
export function fixedStateMessage(pkg: ToolPackageHealth): string {
  switch (pkg.state) {
    case 'installed':
    case 'override':
      return '可用';
    case 'not-installed':
      return '未安装';
    case 'hash-mismatch':
      return '校验失败：文件与固定版本的 hash 不符，绝不带病可用。请卸载后重装。';
    case 'version-mismatch':
      return `版本漂移：安装物与固定版本 ${pkg.version} 不符。请卸载后重装。`;
    case 'condition-missing':
      return pkg.id === 'playwright'
        ? '程序包已安装，但浏览器本体（Chromium）尚未下载。请先安装浏览器。'
        : `程序包已安装，但运行条件缺失（${pkg.detail}）。`;
    default:
      return pkg.detail || '状态未知';
  }
}

export const UI_STATE_LABEL: Readonly<Record<ToolPackageUiState, string>> = Object.freeze({
  unknown: '检测中…',
  checking: '检测中…',
  installing: '安装中',
  'installing-browser': '安装浏览器中',
  verifying: '校验中',
  available: '可用',
  'install-failed': '安装失败',
  unusable: '不可用',
});

/** Whether the health record reads as usable (the §3.3 state machine's 可用). */
export function isHealthAvailable(pkg: ToolPackageHealth): boolean {
  return pkg.available === true;
}

/** The action the UI offers for one package right now. */
export type ToolPackageAction = 'install' | 'install-browser' | 'retry' | 'uninstall' | 'none';

export function actionFor(pkg: ToolPackageHealth, uiState: ToolPackageUiState): ToolPackageAction {
  switch (uiState) {
    case 'unknown':
    case 'checking':
    case 'installing':
    case 'installing-browser':
    case 'verifying':
      return 'none';
    case 'available':
      return 'uninstall';
    case 'install-failed':
      return 'retry';
    case 'unusable':
      // condition-missing on playwright → the browser body is the fix.
      if (pkg.state === 'condition-missing' && pkg.condition && !pkg.condition.ok) {
        return 'install-browser';
      }
      // Anything else unusable is a repair: reinstall from the pinned source.
      return pkg.state === 'not-installed' ? 'install' : 'retry';
    default:
      return pkg.state === 'not-installed' ? 'install' : 'none';
  }
}

/** Pure projection: health record + in-flight action → what the UI renders. */
export function derivePackageView(
  pkg: ToolPackageHealth | undefined,
  action: ToolUiActionState | undefined,
): { uiState: ToolPackageUiState; message: string; action: ToolPackageAction } {
  if (!pkg) return { uiState: action?.kind === 'installing' ? 'installing' : action?.kind === 'verifying' ? 'verifying' : action?.kind === 'installing-browser' ? 'installing-browser' : 'unknown', message: UI_STATE_LABEL.unknown, action: 'none' };
  if (action?.kind === 'installing') {
    return { uiState: 'installing', message: UI_STATE_LABEL.installing, action: 'none' };
  }
  if (action?.kind === 'installing-browser') {
    return { uiState: 'installing-browser', message: UI_STATE_LABEL['installing-browser'], action: 'none' };
  }
  if (action?.kind === 'verifying') {
    return { uiState: 'verifying', message: UI_STATE_LABEL.verifying, action: 'none' };
  }
  const available = isHealthAvailable(pkg);
  const uiState: ToolPackageUiState = available
    ? 'available'
    : action?.kind === 'failed'
      ? 'install-failed'
      : 'unusable';
  return {
    uiState,
    message: action?.kind === 'failed' ? (action.message ?? '') : fixedStateMessage(pkg),
    action: actionFor(pkg, uiState),
  };
}

/** Per-package in-flight/last-action state (session-scoped, never persisted). */
export interface ToolUiActionState {
  readonly kind: 'installing' | 'installing-browser' | 'verifying' | 'failed';
  readonly message?: string;
}

export interface UseToolPlatformStateOptions {
  readonly facade: ToolingFacade | null;
  readonly serviceManager: ServiceManager | null;
}

export interface ToolPlatformState {
  readonly serviceHealth: ServiceHealth;
  readonly packages: readonly ToolPackageHealth[];
  /** Snapshot keyed by package id for O(1) card lookups. */
  readonly byId: Readonly<Record<string, ToolPackageHealth>>;
  readonly actions: Readonly<Record<string, ToolUiActionState>>;
  /** True while the initial (or a requested) health refresh is in flight. */
  readonly loading: boolean;
  /** Fixed message when the tool plane itself cannot answer (§4.4). */
  readonly transportError: string | null;
  readonly refresh: () => Promise<void>;
  readonly install: (id: string) => Promise<boolean>;
  readonly installBrowser: (id: string) => Promise<boolean>;
  readonly uninstall: (id: string) => Promise<boolean>;
}

/**
 * The audit P0-A §3.3-1 hook: after the Service Host is ready, ask
 * `tooling.health` once and keep the four packages' truth in React state.
 * Also re-checks when the host comes back (restart) so the UI can never sit
 * on a stale "可用" while the sidecar re-derives the truth.
 */
export function useToolPlatformState(options: UseToolPlatformStateOptions): ToolPlatformState {
  const { facade, serviceManager } = options;
  const [serviceHealth, setServiceHealth] = useState<ServiceHealth>(
    serviceManager?.currentHealth ?? 'stopped',
  );
  const [packages, setPackages] = useState<readonly ToolPackageHealth[]>([]);
  const [actions, setActions] = useState<Record<string, ToolUiActionState>>({});
  const [loading, setLoading] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const healthSequence = useRef(0);

  useEffect(() => {
    if (!serviceManager) return undefined;
    return serviceManager.onHealth(setServiceHealth);
  }, [serviceManager]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!facade) return;
    const seq = healthSequence.current + 1;
    healthSequence.current = seq;
    setLoading(true);
    try {
      const result: ToolingHealthResult | null = await facade.health();
      // A stale answer (a newer refresh already started) must not win.
      if (seq !== healthSequence.current) return;
      if (result && result.ok) {
        setPackages(result.packages);
        setTransportError(null);
      } else {
        setTransportError('工具服务未返回健康状态');
      }
    } catch {
      if (seq === healthSequence.current) {
        setTransportError('工具服务不可用');
      }
    } finally {
      if (seq === healthSequence.current) setLoading(false);
    }
  }, [facade]);

  // §3.3-1: one health call when the Service Host first becomes ready, and
  // one whenever it RE-enters ready (a restart invalidates on-disk truth
  // cached in this component).
  useEffect(() => {
    if (serviceHealth === 'ready') void refresh();
  }, [serviceHealth, refresh]);

  const setAction = useCallback((id: string, state: ToolUiActionState | null) => {
    setActions((prev) => {
      const next = { ...prev };
      if (state === null) delete next[id];
      else next[id] = state;
      return next;
    });
  }, []);

  const install = useCallback(async (id: string): Promise<boolean> => {
    if (!facade) return false;
    setAction(id, { kind: 'installing' });
    try {
      const result = await facade.install(id);
      if (!result.ok) {
        setAction(id, { kind: 'failed', message: fixedInstallError(id, result.reasonCode, result.error) });
        return false;
      }
      // §3.3-6: install done → verify via health before claiming 可用.
      setAction(id, { kind: 'verifying' });
      await refresh();
      setAction(id, null);
      return true;
    } catch (error) {
      setAction(id, { kind: 'failed', message: transportFailureMessage(id, error) });
      return false;
    }
  }, [facade, refresh, setAction]);

  const installBrowser = useCallback(async (id: string): Promise<boolean> => {
    if (!facade) return false;
    setAction(id, { kind: 'installing-browser' });
    try {
      const result = await facade.installBrowser(id);
      if (!result.ok) {
        setAction(id, { kind: 'failed', message: fixedInstallError(id, result.reasonCode, result.error) });
        return false;
      }
      setAction(id, { kind: 'verifying' });
      await refresh();
      setAction(id, null);
      return true;
    } catch (error) {
      setAction(id, { kind: 'failed', message: transportFailureMessage(id, error) });
      return false;
    }
  }, [facade, refresh, setAction]);

  const uninstall = useCallback(async (id: string): Promise<boolean> => {
    if (!facade) return false;
    setAction(id, { kind: 'verifying' });
    try {
      const result = await facade.uninstall(id);
      if (!result.ok) {
        // The uninstall RPC reports a reasonCode but no raw error text; the
        // fixed message keeps the UI honest without inventing a cause.
        setAction(id, {
          kind: 'failed',
          message: fixedUninstallError(result.reasonCode),
        });
        return false;
      }
      await refresh();
      setAction(id, null);
      return true;
    } catch (error) {
      setAction(id, { kind: 'failed', message: transportFailureMessage(id, error) });
      return false;
    }
  }, [facade, refresh, setAction]);

  const byId = useMemo(() => {
    const map: Record<string, ToolPackageHealth> = {};
    for (const p of packages) map[p.id] = p;
    return map;
  }, [packages]);

  return {
    serviceHealth,
    packages,
    byId,
    actions,
    loading,
    transportError,
    refresh,
    install,
    installBrowser,
    uninstall,
  };
}

/** Fixed text for a package action that died at the transport layer (the
 *  request threw instead of answering `ok:false`). The raw message may name
 *  machine paths — it only selects a fixed message (§3.3). */
function transportFailureMessage(id: string, error: unknown): string {
  const code = error instanceof ServiceRequestError ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return fixedInstallError(id, code, message);
}

/** Fixed uninstall-failure text per reason code. */
function fixedUninstallError(reasonCode: string | undefined): string {
  if (reasonCode === 'target_locked') {
    return '卸载目标被占用：可能有正在运行的浏览器/电脑控制任务。请停止当前任务后重试。';
  }
  return reasonCode ? `卸载失败（${reasonCode}）。` : '卸载失败。';
}

/** Fixed install-failure text per reason code (§3.3: 固定错误文案). The raw
 *  error may name machine paths or arrive as an English stack tail — it is
 *  NEVER rendered verbatim; at most it selects a fixed message. */
export function fixedInstallError(_id: string, reasonCode: string | undefined, rawError: string | undefined): string {
  const raw = rawError ?? '';
  // Transport-layer failures surface through the catch path with a
  // ServiceRequestError code rather than a sidecar reasonCode.
  if (reasonCode === 'TIMEOUT' || /timed out|timeout/i.test(raw)) {
    return '安装请求超时：下载可能仍在后台进行，也可能是网络过慢。请稍后重试。';
  }
  if (reasonCode === 'NOT_CONNECTED') {
    return '工具服务不可用：无法发起安装。请重启 Trylo 后重试。';
  }
  if (reasonCode === 'target_locked' || /EBUSY|EPERM|resource busy or locked/i.test(raw)) {
    return '安装目标被占用：可能有正在运行的浏览器/电脑控制任务，或杀毒软件正在扫描。请停止当前任务后重试。';
  }
  switch (reasonCode) {
    case 'hash_mismatch':
      return '下载物与固定版本 hash 不符，已放弃安装（不会带病落盘）。';
    case 'download_failed':
      return '下载失败：无法取得固定版本的发布物。请检查网络（需可达 GitHub / npm registry）后重试。';
    case 'uv_missing':
      return '本机缺少 uv 运行时，无法安装此包。请先安装 uv 后重试（uv 是 Windows-MCP 的受控 Python 运行条件）。';
    case 'no_install_root':
      return '工具安装目录未配置（Service Host 存储根缺失）。';
    case 'unknown_package':
      return '此工具不在当前 Trylo 工具目录中。';
    case 'strategy_unsupported':
      return '此包的安装策略在当前版本没有传输实现。';
    case 'playwright_cli_missing':
    case 'browser_install_failed':
      return '浏览器本体安装失败。请重试；反复失败请查看诊断日志。';
    default:
      // §3.3: the raw error is never shown — absolute paths and English
      // internals leak machine context into the UI (2026-09-03 acceptance).
      return `安装失败（${reasonCode ?? '未知原因'}）。请重试；反复失败请查看诊断日志。`;
  }
}

/**
 * The pre-send capability gate (audit §3.3-5): given the resolved runtime's
 * unavailable capabilities and the user's text, decide what the Work send
 * does.
 *
 *   - no capabilities → `allow`
 *   - missing packages, request does not explicitly need them → `degrade`
 *     (non-blocking capability notice)
 *   - request explicitly needs a missing capability → `block` (阻止伪开工)
 *
 * The keyword match is deliberately narrow (product names + strong Chinese
 * task nouns): a false "needs office" on an ordinary message must never
 * block a legitimate file write.
 */
export type CapabilityGateDecision =
  | { readonly behavior: 'allow' }
  | { readonly behavior: 'degrade'; readonly notice: string }
  | { readonly behavior: 'block'; readonly notice: string; readonly missingIds: readonly string[] };

const CAPABILITY_SIGNALS: readonly { readonly id: string; readonly patterns: readonly RegExp[] }[] = [
  {
    // Office surface: the package id is officecli.
    id: 'officecli',
    patterns: [
      /\b(docx|xlsx|pptx|pdf)\b/i,
      /word|excel|powerpoint|office/i,
      /文档|表格|幻灯片|演示文稿|工作簿|会议纪要|周报.*(docx|xlsx|pptx|pdf)/i,
    ],
  },
  {
    // Browser surface: playwright OR chrome-devtools both satisfy it.
    id: 'playwright|chrome-devtools',
    patterns: [
      /浏览器|网页|web 页|网站|登录.*(网页|网站)/i,
      /\b(browser|playwright|chrome)\b/i,
    ],
  },
  {
    // Desktop-control surface.
    id: 'windows-mcp',
    patterns: [
      /电脑|桌面|鼠标|键盘|截屏|截取.*屏幕|屏幕截图/i,
      /\b(computer use|desktop)\b/i,
    ],
  },
  {
    // CAD/EDA adapter surface (TRYLO-CAD-EDA-TOOL-ADAPTER §8): any one of
    // the six adapters satisfies it. The gate only fires while work.cad.v1
    // is the active Profile, so these product names never block a run that
    // never asked for the CAD tools.
    id: 'solidworks-mcp|autocad-mcp|kicad-mcp|jlceda-mcp|freecad-mcp|blender-mcp',
    patterns: [
      /solidworks|autocad|\bkicad\b|嘉立创|立创eda|\bfreecad\b|\bblender\b/i,
      /\b(cad|eda|pcb)\b/i,
      /原理图|布线|封装|打样|装配体|工程图/,
    ],
  },
];

function capabilityIdsForText(text: string): readonly string[] {
  const ids: string[] = [];
  for (const signal of CAPABILITY_SIGNALS) {
    if (signal.patterns.some((p) => p.test(text))) ids.push(signal.id);
  }
  return ids;
}

/** Does the unavailable capability list satisfy a signal id? `a|b` means
 *  EITHER package makes the capability present: satisfied iff at least one
 *  alternative is NOT unavailable. */
function capabilitySatisfied(signalId: string, unavailableIds: readonly string[]): boolean {
  const alternatives = signalId.split('|');
  return alternatives.some((alt) => !unavailableIds.includes(alt));
}

export function decideSendCapabilityGate(
  text: string,
  unavailableCapabilities: readonly {
    readonly id: string;
    readonly type: string;
    readonly displayName?: string;
    readonly userMessage?: string;
  }[],
): CapabilityGateDecision {
  if (unavailableCapabilities.length === 0) return { behavior: 'allow' };
  const packageCapabilities = unavailableCapabilities.filter((c) => c.type === 'package');
  if (packageCapabilities.length === 0) {
    // Adapter-level (hermes) degradation is informational only.
    return { behavior: 'allow' };
  }
  const missingIds = packageCapabilities.map((c) => c.id);
  // §3.3 / tooling/types.ts describeUnavailableCapabilities: the raw
  // `userMessage`/`detail` may carry absolute paths and English internals —
  // the chat bubble shows the DISPLAY NAME only.
  const labels = packageCapabilities.map((c) => c.displayName ?? c.id);
  const notice = `本次运行缺少可选工具：${labels.join('、')}。可在 设置 → Work 工具 安装；本次先以现有能力继续。`;

  // Which capabilities does the user's request EXPLICITLY need? A needed
  // capability that is missing blocks the pseudo-start (audit §3.3-5).
  const needed = capabilityIdsForText(text);
  const blocked = needed.filter((signalId) => !capabilitySatisfied(signalId, missingIds));
  if (blocked.length > 0) {
    const blockedLabels = blocked.map((signalId) =>
      packageCapabilities
        .filter((c) => signalId.split('|').includes(c.id))
        .map((c) => c.displayName ?? c.id)
        .join('、'),
    ).filter(Boolean);
    return {
      behavior: 'block',
      notice: `您的请求需要的能力当前不可用：${blockedLabels.join('、')}。已阻止发送以避免伪开工。可在 设置 → Work 工具 安装后重试。`,
      missingIds,
    };
  }
  return { behavior: 'degrade', notice };
}
