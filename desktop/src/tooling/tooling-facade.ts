// Trylo Desktop — Tooling facade over the Service Host.
//
// The only renderer-side implementation of the tooling protocol. Transport
// only: one typed request per `tooling.*` method, no caching, no policy, no
// retry. Every degrade decision belongs to the caller, because only the
// caller knows whether a missing tool is fatal for this surface.
//
// Failure policy (spec §4.4):
//   - `ok:false` from the host resolves as `null` for the resolver — the run
//     continues WITHOUT a Profile rather than failing.
//   - A transport failure (Service Host down) also resolves as `null`.
//     Optional callers may degrade; required Work sends surface the error.
//   - `health` / `listProfiles` surface their `ok:false` to the caller so
//     Diagnostics can show the real reason instead of an empty list.

import type { ServicesClient } from '../services-host/services-client';
import { ServiceRequestError } from '../services-host/services-client';
import type {
  ComputerPreviewStartParams,
  ComputerPreviewResult,
  ResolvedToolRuntime,
  ToolingHealthResult,
  ToolingInstallBrowserResult,
  ToolingInstallResult,
  ToolingLocalOverrideMutationResult,
  ToolingLocalOverridesResult,
  ToolingListProfilesResult,
  ToolingListRuntimeArtifactsResult,
  ToolingOfficeValidationCapabilitiesResult,
  ToolingPromoteArtifactResult,
  ToolingSweepToolCacheResult,
  ToolingUninstallResult,
  ToolingValidateOfficeArtifactsParams,
  ToolingValidateOfficeArtifactsResult,
  ViewportInputParams,
  ViewportInputResult,
  ViewportNavigateResult,
  ViewportResizeParams,
  ViewportResizeResult,
  ViewportStartResult,
  ViewportStopResult,
} from '../services-host/methods';
import type { ResolveToolRuntimeRequest } from './types';
import { nativeBrowserCommand } from '../host-adapter/native-browser';

/**
 * Sidecar JOB budgets (per-call `timeoutMs` overrides; the RPC default is
 * 30s). Installs stream large pinned artifacts — the OfficeCLI exe, the
 * whole playwright tarball closure, and a cold uv sync which alone may
 * budget 600s — so the renderer must out-wait the sidecar, or the UI would
 * flip to 安装失败 while the download was still making progress.
 */
const INSTALL_TIMEOUT_MS = 900_000;
const UNINSTALL_TIMEOUT_MS = 120_000;
/** health probes each installed package's `--version` with its own bound. */
const HEALTH_TIMEOUT_MS = 120_000;
// Profile composition also probes packages and prepares the native browser.
// Its cold-start work must have the same budget as package health.
const PROFILE_TIMEOUT_MS = HEALTH_TIMEOUT_MS;

function profileFailureMessage(code: string): string {
  if (code === 'config_write_failed') {
    return '工具配置无法保存，请检查 Trylo 数据目录的写入权限，并从正常桌面环境重新启动 Trylo 后重试。';
  }
  if (code === 'TIMEOUT') return '工具加载超时，请稍后重试。';
  return '工具服务尚未就绪，请稍后重试；若持续失败，请重新启动 Trylo。';
}

export function createToolingFacade(client: ServicesClient) {
  return {
    // Subscribe during effect setup, not facade construction in render.
    // StrictMode discards a render and replays setup/cleanup; each setup
    // must attach to the committed client and return its own cleanup.
    connectNativeBridge: (): (() => void) => client.onEvent('tooling.nativeBrowserCommand', command => {
      void nativeBrowserCommand(command).then(
        result => client.request('tooling.nativeBrowserCommandResult', { id: command.id, result }),
        error => client.request('tooling.nativeBrowserCommandResult', { id: command.id, error: error instanceof Error ? error.message : String(error) }),
      ).catch(() => {});
    }),
    nativeBrowserOpen: (scope: { readonly projectRoot: string; readonly conversationId: string }) => client.request('tooling.nativeBrowserOpen', scope, { timeoutMs: 60000 }),
    nativeBrowserState: (scope: string) => client.request('tooling.nativeBrowserState', { scope }),
    nativeBrowserControl: (scope: string, heldByUser: boolean) => client.request('tooling.nativeBrowserControl', { scope, heldByUser }),
    nativeBrowserSelect: (scope: string, label: string) => client.request('tooling.nativeBrowserSelect', { scope, label }),
    nativeBrowserCreate: (scope: string) => client.request('tooling.nativeBrowserCreate', { scope }),
    nativeBrowserLayout: (scope: string, bounds: import('../host-adapter/native-browser').NativeBrowserBounds | undefined, visible: boolean) => client.request('tooling.nativeBrowserLayout', { scope, bounds, visible }),
    nativeBrowserViewport: (scope: string, label: string, viewport: import('../host-adapter/native-browser').NativeBrowserViewportRequest) => client.request('tooling.nativeBrowserViewport', { scope, label, viewport }),
    /**
     * Compose one run's tool Profile, or `null` when the tool plane cannot
     * answer. Required sends reject with a safe, actionable error instead.
     */
    async resolveProfile(
      request: ResolveToolRuntimeRequest,
      options?: { readonly required?: boolean },
    ): Promise<ResolvedToolRuntime | null> {
      try {
        const result = await client.request('tooling.resolveProfile', {
          surface: request.surface,
          ...(request.requestedProfileId
            ? { requestedProfileId: request.requestedProfileId }
            : {}),
          ...(request.computerUse !== undefined
            ? { computerUse: request.computerUse }
            : {}),
          projectKey: request.projectKey,
          projectRoot: request.projectRoot,
          conversationId: request.conversationId,
        }, { timeoutMs: PROFILE_TIMEOUT_MS });
        if (result.ok) return result as ResolvedToolRuntime;
        if (options?.required) {
          throw new ServiceRequestError(result.reasonCode, profileFailureMessage(result.reasonCode));
        }
        return null;
      } catch (error) {
        if (error instanceof ServiceRequestError) {
          if (options?.required) throw new ServiceRequestError(error.code, profileFailureMessage(error.code));
          return null;
        }
        throw error;
      }
    },

    async health(id?: string): Promise<ToolingHealthResult | null> {
      try {
        return await client.request('tooling.health', id ? { id } : {}, {
          timeoutMs: HEALTH_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof ServiceRequestError) return null;
        throw error;
      }
    },

    async listProfiles(): Promise<ToolingListProfilesResult | null> {
      try {
        return await client.request('tooling.listProfiles');
      } catch (error) {
        if (error instanceof ServiceRequestError) return null;
        throw error;
      }
    },

    async install(id: string, archivePath?: string): Promise<ToolingInstallResult> {
      return client.request('tooling.install', {
        id,
        ...(archivePath ? { archivePath } : {}),
      }, { timeoutMs: INSTALL_TIMEOUT_MS });
    },

    async uninstall(id: string): Promise<ToolingUninstallResult> {
      return client.request('tooling.uninstall', { id }, {
        timeoutMs: UNINSTALL_TIMEOUT_MS,
      });
    },

    /** Bind a package to a developer-built local entrypoint. The sidecar
     * persists the binding and invalidates health immediately. */
    async setLocalOverride(id: string, path: string): Promise<ToolingLocalOverrideMutationResult> {
      return client.request('tooling.setLocalOverride', { id, path });
    },

    async clearLocalOverride(id: string): Promise<ToolingLocalOverrideMutationResult> {
      return client.request('tooling.clearLocalOverride', { id });
    },

    async localOverrides(): Promise<ToolingLocalOverridesResult | null> {
      try {
        return await client.request('tooling.localOverrides');
      } catch (error) {
        if (error instanceof ServiceRequestError) return null;
        throw error;
      }
    },

    /** §3.3-7: install the browser body a package's browserCondition needs
     *  (playwright → pinned chromium). The caller re-runs `health()` after
     *  this — the condition probe, not this result, is the authority. */
    async installBrowser(id: string): Promise<ToolingInstallBrowserResult> {
      return client.request('tooling.installBrowser', { id }, {
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
    },

    /** Embedded browser panel (fork of vscode-browser-preview's CDP
     *  screencast architecture). `viewportStart` may take a while to boot
     *  Chromium and locate a page target — grant it a generous budget. */
    async viewportStart(cdpPort?: number, scope?: { readonly projectRoot: string; readonly conversationId: string }, viewport?: { readonly width: number; readonly height: number }): Promise<ViewportStartResult> {
      return client.request('tooling.viewportStart', {
        ...(scope ?? (cdpPort ? { cdpPort } : {})),
        ...(viewport ? { viewportWidth: viewport.width, viewportHeight: viewport.height } : {}),
      }, {
        timeoutMs: 60_000,
      });
    },

    /** Re-emulate the page to the panel's current box. Called on panel resize
     *  so the frame keeps filling the sidebar instead of letterboxing. */
    async viewportResize(params: ViewportResizeParams): Promise<ViewportResizeResult> {
      return client.request('tooling.viewportResize', params);
    },

    async viewportNavigate(url: string): Promise<ViewportNavigateResult> {
      return client.request('tooling.viewportNavigate', { url });
    },

    async viewportInput(params: ViewportInputParams): Promise<ViewportInputResult> {
      return client.request('tooling.viewportInput', params);
    },

    async viewportStop(): Promise<ViewportStopResult> {
      return client.request('tooling.viewportStop');
    },

    async computerPreviewStart(params: ComputerPreviewStartParams): Promise<ComputerPreviewResult> {
      return client.request('tooling.computerPreviewStart', params);
    },

    async computerPreviewStop(params?: string | { readonly scope?: string; readonly streamId?: string }): Promise<ComputerPreviewResult> {
      return client.request('tooling.computerPreviewStop', typeof params === 'string' ? { scope: params } : params);
    },

    async computerPreviewAck(params: { readonly scope: string; readonly streamId: string; readonly seq: number }): Promise<ComputerPreviewResult> {
      return client.request('tooling.computerPreviewAck', params);
    },

    /** PR-3 (§6.5): what the browser left in THIS conversation's runtime
     *  temp dir. `null` on transport failure — promotion is additive. */
    async listRuntimeArtifacts(
      params: { projectRoot: string; conversationId: string; packageId: string },
    ): Promise<ToolingListRuntimeArtifactsResult | null> {
      try {
        return await client.request('tooling.listRuntimeArtifacts', params);
      } catch (error) {
        if (error instanceof ServiceRequestError) return null;
        throw error;
      }
    },

    /** PR-3 (§6.5/§7.3): promote one runtime temp artifact into .trylo/out.
     *  The explicit, user-driven step — never automatic (process results are
     *  not deliverables). */
    async promoteArtifact(
      params: { projectRoot: string; conversationId: string; packageId: string; fileName: string; targetName?: string },
    ): Promise<ToolingPromoteArtifactResult> {
      return client.request('tooling.promoteArtifact', params);
    },

    /** PR-4 (§7.1): run the BinaryRef tool-cache TTL sweep on demand
     *  (background sweep runs hourly in the Service Host). Diagnostics
     *  affordance; never blocks anything. */
    async sweepToolCache(): Promise<ToolingSweepToolCacheResult | null> {
      try {
        return await client.request('tooling.sweepToolCache', {});
      } catch (error) {
        if (error instanceof ServiceRequestError) return null;
        throw error;
      }
    },

    /** PR-5 (§11): per-engine capability state for the Office validation
     *  pipeline (§4.4 — a missing capability must be reportable WITH its
     *  reason, which is exactly what the degradation UI needs). `null` on
     *  transport failure: a diagnostics query never blocks a run. */
    async officeValidationCapabilities(
      params: { refresh?: boolean } = {},
    ): Promise<ToolingOfficeValidationCapabilitiesResult | null> {
      try {
        return await client.request('tooling.officeValidationCapabilities', params);
      } catch (error) {
        if (error instanceof ServiceRequestError) return null;
        throw error;
      }
    },

    /** PR-5 (§11): run the deterministic Office delivery validation over one
     *  run's `.trylo/out` deliverables. Never rejects — the caller decides
     *  what a transport failure means for the projection (absent verdict,
     *  never an implied pass). */
    async validateOfficeArtifacts(
      params: ToolingValidateOfficeArtifactsParams,
    ): Promise<ToolingValidateOfficeArtifactsResult | null> {
      try {
        return await client.request('tooling.validateOfficeArtifacts', params);
      } catch (error) {
        if (error instanceof ServiceRequestError) return null;
        throw error;
      }
    },
  };
}

export type ToolingFacade = ReturnType<typeof createToolingFacade>;

/**
 * Bind the facade to the run-time resolver contract. Kept separate from the
 * transport so tests can inject a plain resolver without a client.
 */
export function createToolingRuntimeResolver(
  facade: ToolingFacade,
): (request: ResolveToolRuntimeRequest) => Promise<ResolvedToolRuntime | null> {
  return (request) => facade.resolveProfile(request);
}
