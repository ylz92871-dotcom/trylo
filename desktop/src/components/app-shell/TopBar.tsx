// Trylo Desktop — TopBar. See spike-results/phase-2-ui-redesign.md.
//
// v1.5: two top-level modes — Code and Work. The brand
// logo is bigger (28px). No Fun tab.
//
// v1.15: a gear (⚙) button on the right side opens the
// Settings modal. The button lives in the topBar__right
// region alongside the StatusDot. See v1.15-handoff §1.2.
//
// M4-D: the Code / Work switch is now a real segmented
// control with icon + label, the active tab using
// --mode-accent tokens (gold for both modes; Code reads
// sharper, Work reads warmer). StatusDot + "Personal
// Agent" duplicated ProcessHeader's status line; they
// are dropped from the right region — the composer's
// ProcessHeader is the single source of truth for state.
//
// 2026-08-29 pass:
//   * Top-left brand lockup redesigned for a calmer
//     minimal look — the 48px Iowan Old Style
//     wordmark becomes a 22px gold mark + a small
//     rounded chip with a hairline border.
//   * The remote-access quick toggle moves here from
//     Settings (the visual "fairness" principle: features
//     that are switches live in the top bar; features that
//     are configuration stay in Settings). The settings
//     modal keeps the full remote configurator
//     (port / tunnel / pairing QR).
import type { ReactElement, ReactNode } from 'react';
import { Code2, Briefcase, Globe, RadioTower } from 'lucide-react';
import { Logo } from '../brand/Logo';
import type { TopLevelMode } from '../../host-adapter/types';

export interface TopBarProps {
  readonly topMode: TopLevelMode;
  readonly onTopModeChange: (mode: TopLevelMode) => void;
  /**
   * The embedded browser panel (2026-09-04 lightening pass): ONE globe
   * icon here is the single entry for BOTH Code and Work — the panel
   * itself floats at the shell level. Absent callback → no button.
   */
  readonly browserPreviewOpen?: boolean;
  readonly onToggleBrowserPreview?: () => void;
  /**
   * Optional right-side content. The segmented mode
   * control, the activity chip, and the settings button
   * are owned by the TopBar. Anything passed here is
   * rendered between the activity chip and the settings
   * button. (M4-D: in practice this is empty now that
   * StatusDot has been folded into ProcessHeader.)
   */
  readonly right?: ReactNode;
  /**
   * Person | Team surface: a second tablist, rendered next
   * to the brand. Code/Work is shifted toward the main-column
   * centre and would overlap a right-side switch.
   */
  readonly collaborationSwitch?: ReactNode;
  /** Opens the Settings modal. v1.15. */
  readonly onOpenSettings?: () => void;
  /**
   * M4-D: number of in-flight Code runs across all
   * conversations. When > 0 the TopBar renders an
   * activity chip that opens the Background Activity
   * Center via `onOpenActivityCenter`.
   */
  readonly activeCodeRuns?: number;
  /** M4-D: opens the Background Activity Center. */
  readonly onOpenActivityCenter?: () => void;
  /**
   * 2026-08-29: the TopBar "远程" button opens the remote
   * pairing modal (see RemotePairingModal) — the single
   * home for the pairing QR, which used to live inside
   * Settings. The modal itself contains the enable/disable
   * switch, so `onRemoteToggle` is forwarded there; this
   * button no longer flips the switch directly.
   */
  readonly remoteEnabled?: boolean;
  readonly remoteRunning?: boolean;
  readonly onOpenRemotePairing?: () => void;
  /** Forwarded into the pairing modal's enable switch. */
  readonly onRemoteToggle?: () => void;
}

export function TopBar(props: TopBarProps): ReactElement {
  const activeCount = props.activeCodeRuns ?? 0;
  const remote = props.remoteEnabled ?? false;
  const remoteLive = remote && (props.remoteRunning ?? false);
  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <span className="top-bar__brand-mark" aria-hidden="true">
          <Logo size={20} decorative />
        </span>
        <span className="top-bar__brand-name">Trylo</span>
        {props.collaborationSwitch ? (
          <span className="top-bar__collaboration">
            {props.collaborationSwitch}
          </span>
        ) : null}
      </div>
      <div
        className="top-bar__modes"
        role="tablist"
        aria-label="Top-level mode"
      >
        <ModeTab
          selected={props.topMode === 'code'}
          onClick={() => props.onTopModeChange('code')}
          label="Code"
          icon={<Code2 size={14} strokeWidth={2.2} aria-hidden="true" />}
        />
        <ModeTab
          selected={props.topMode === 'work'}
          onClick={() => props.onTopModeChange('work')}
          label="Work"
          icon={<Briefcase size={14} strokeWidth={2.2} aria-hidden="true" />}
        />
      </div>
      <div className="top-bar__right">
        {activeCount > 0 && props.onOpenActivityCenter !== undefined && (
          <button
            type="button"
            className="top-bar__active-chip"
            onClick={props.onOpenActivityCenter}
            aria-label={
              `${activeCount} active Code run${activeCount > 1 ? 's' : ''}. ` +
              'Open Activity Center.'
            }
            title={
              `${activeCount} active Code run${activeCount > 1 ? 's' : ''}`
            }
          >
            <span className="top-bar__active-dot" aria-hidden="true" />
            <span className="top-bar__active-count">
              {activeCount} active
            </span>
          </button>
        )}
        {props.right}
        {props.onOpenRemotePairing !== undefined && (
          <button
            type="button"
            className={
              'top-bar__remote-btn' +
              (remote ? ' top-bar__remote-btn--on' : '') +
              (remoteLive ? ' top-bar__remote-btn--live' : '')
            }
            onClick={props.onOpenRemotePairing}
            title={
              remote
                ? '远程访问已启用 — 点击查看二维码 / 设置'
                : '远程访问已关闭 — 点击启用并扫码连接'
            }
            aria-haspopup="dialog"
            aria-label={
              remote
                ? '远程访问已启用。点击打开配对面板。'
                : '远程访问已关闭。点击启用远程访问。'
            }
          >
            <RadioTower size={16} strokeWidth={2} aria-hidden="true" />
            <span className="top-bar__remote-dot" aria-hidden="true" />
            <span className="top-bar__remote-label">远程</span>
          </button>
        )}
        {props.onToggleBrowserPreview !== undefined && (
          <button
            type="button"
            className={
              'top-bar__browser-btn' +
              (props.browserPreviewOpen ? ' top-bar__browser-btn--on' : '')
            }
            onClick={props.onToggleBrowserPreview}
            title={props.browserPreviewOpen ? '收起浏览器面板' : '打开浏览器面板（全程本机）'}
            aria-label={props.browserPreviewOpen ? '收起浏览器面板' : '打开浏览器面板'}
            aria-pressed={props.browserPreviewOpen}
          >
            <Globe size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        {props.onOpenSettings !== undefined && (
          <button
            type="button"
            className="settings-btn"
            onClick={props.onOpenSettings}
            title="Settings"
            aria-label="Open settings"
          >
            <span aria-hidden="true">⚙</span>
          </button>
        )}
      </div>
    </header>
  );
}

interface ModeTabProps {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly label: string;
  readonly icon: ReactNode;
}

function ModeTab(props: ModeTabProps): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.selected}
      aria-current={props.selected ? 'page' : undefined}
      className={`top-mode${props.selected ? ' top-mode--active' : ''}`}
      onClick={props.onClick}
    >
      <span className="top-mode__icon" aria-hidden="true">
        {props.icon}
      </span>
      <span className="top-mode__label">{props.label}</span>
    </button>
  );
}
