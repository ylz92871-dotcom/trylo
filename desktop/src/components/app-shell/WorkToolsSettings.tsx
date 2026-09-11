// Trylo Desktop — Work tools settings section (audit P0-A §3.3).
//
// The visible face of the Trylo Tool Platform: the four managed packages
// with their version, adoption tier, health state and FIXED error text, plus
// install / install-browser / retry / uninstall actions driven by the
// existing `tooling.*` RPCs. This component adds no installer logic — it
// renders `useToolPlatformState` and calls back.
//
// Acceptance gates this component exists for (audit §3.5):
//   - a new user sees the four packages' real states on first open;
//   - OfficeCLI / Playwright / Chrome DevTools install without a terminal;
//   - Windows-MCP missing uv/Python says exactly what is missing;
//   - hash / version drift shows FAILED, never usable.

import type { ReactElement } from 'react';
import type {
  ToolPackageHealth,
} from '../../services-host/methods';
import {
  UI_STATE_LABEL,
  derivePackageView,
  type ToolPlatformState,
  type ToolPackageUiState,
} from '../../tooling/use-tool-platform-state';

export interface WorkToolsSettingsProps {
  readonly platform: ToolPlatformState;
}

const ADOPTION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  stable: '稳定',
  trial: '试用',
  developer: '开发者',
});

function stateTone(uiState: ToolPackageUiState): string {
  if (uiState === 'available') return 'ok';
  if (uiState === 'install-failed' || uiState === 'unusable') return 'err';
  return 'pending';
}

function PackageRow(props: {
  readonly pkg: ToolPackageHealth;
  readonly platform: ToolPlatformState;
}): ReactElement {
  const { pkg, platform } = props;
  const view = derivePackageView(pkg, platform.actions[pkg.id]);
  const busy =
    view.uiState === 'installing' ||
    view.uiState === 'verifying' ||
    view.uiState === 'installing-browser' ||
    view.uiState === 'checking';

  const onAction = (): void => {
    switch (view.action) {
      case 'install':
      case 'retry':
        void platform.install(pkg.id);
        break;
      case 'install-browser':
        void platform.installBrowser(pkg.id);
        break;
      case 'uninstall':
        void platform.uninstall(pkg.id);
        break;
      default:
        break;
    }
  };

  const actionLabel =
    view.action === 'install' ? '安装'
    : view.action === 'install-browser' ? '安装浏览器'
    : view.action === 'retry' ? '重试'
    : view.action === 'uninstall' ? '卸载'
    : null;

  return (
    <div className={`work-tools__row work-tools__row--${stateTone(view.uiState)}`}>
      <div className="work-tools__row-head">
        <span className="work-tools__name">{pkg.displayName}</span>
        <span className="work-tools__version">{pkg.version}</span>
        <span className="work-tools__adoption">{ADOPTION_LABEL[pkg.adoption] ?? pkg.adoption}</span>
        <span
          className={`work-tools__state work-tools__state--${stateTone(view.uiState)}`}
          role="status"
        >
          {UI_STATE_LABEL[view.uiState]}
        </span>
        {actionLabel ? (
          <button
            type="button"
            className="work-tools__action"
            onClick={onAction}
            disabled={busy}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
      <div className="work-tools__detail">{view.message}</div>
    </div>
  );
}

export function WorkToolsSettings(props: WorkToolsSettingsProps): ReactElement {
  const { platform } = props;
  return (
    <fieldset className="settings-modal__group work-tools">
      <legend className="settings-modal__legend">Work 工具</legend>
      <p className="settings-modal__desc">
        Work 会话通过这些受审计的工具包获得 Office / 浏览器 / 电脑控制能力。状态与安装进度在此可见，缺失不会静默。
      </p>

      {platform.serviceHealth !== 'ready' ? (
        <div className="work-tools__row work-tools__row--err" role="status">
          <div className="work-tools__detail">
            工具服务未就绪（{platform.serviceHealth}）。服务恢复后状态会自动刷新。
          </div>
        </div>
      ) : null}

      {platform.transportError ? (
        <div className="work-tools__row work-tools__row--err" role="alert">
          <div className="work-tools__detail">{platform.transportError}</div>
        </div>
      ) : null}

      {!platform.transportError && platform.packages.length === 0 && platform.loading ? (
        <div className="work-tools__row">
          <div className="work-tools__detail">正在读取工具健康状态…</div>
        </div>
      ) : null}

      {platform.packages.map((pkg) => (
        <PackageRow key={pkg.id} pkg={pkg} platform={platform} />
      ))}
    </fieldset>
  );
}
