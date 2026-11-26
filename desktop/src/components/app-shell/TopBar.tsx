import { ChevronRight, PanelLeftOpen } from 'lucide-react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';
import type { TopLevelMode } from '../../host-adapter/types';
import { isInteractiveTitlebarTarget, toggleNativeWindowZoom } from '../../host-adapter/native-shell';
import { formatShortcut, isMacPlatform } from '../../utils/platform';

export interface TopBarProps {
  readonly workspaceName: string;
  readonly conversationTitle?: string;
  readonly collapsed: boolean;
  readonly onToggleLeftRail: () => void;
  readonly topMode?: TopLevelMode;
  readonly onTopModeChange?: (mode: TopLevelMode) => void;
  readonly right?: ReactNode;
  readonly collaborationSwitch?: ReactNode;
}

const TOP_MODES: readonly { readonly id: TopLevelMode; readonly label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'work', label: 'Work' },
];

export function TopBar(props: TopBarProps): ReactElement {
  const mac = isMacPlatform();
  const dragProps = mac ? { 'data-tauri-drag-region': '' } : undefined;
  const noDragProps = mac ? { 'data-tauri-drag-region': 'false' } : undefined;

  const onHeaderDoubleClick = (event: MouseEvent<HTMLElement>): void => {
    if (!mac || isInteractiveTitlebarTarget(event.target)) return;
    void toggleNativeWindowZoom();
  };

  return (
    <header
      className="top-bar"
      data-rail-collapsed={props.collapsed ? 'true' : 'false'}
      onDoubleClick={onHeaderDoubleClick}
      {...dragProps}
    >
      <div className="top-bar__breadcrumb" {...dragProps}>
        {props.collapsed && (
          <button
            type="button"
            className="top-bar__icon"
            onClick={props.onToggleLeftRail}
            aria-label="Expand rail"
            title={mac ? `展开侧栏 ${formatShortcut(['Mod', 'B'])}` : '展开侧栏'}
            {...noDragProps}
          >
            <PanelLeftOpen size={mac ? 16 : 17} />
          </button>
        )}
        <span className="top-bar__workspace" {...dragProps}>
          {props.workspaceName}
        </span>
        <ChevronRight size={12} aria-hidden="true" />
        <span className="top-bar__title" title={props.conversationTitle} {...dragProps}>
          {props.conversationTitle || '新任务'}
        </span>
      </div>

      {props.topMode && props.onTopModeChange && (
        <div
          className="top-bar__mode-switch"
          role="group"
          aria-label="工作模式"
          {...noDragProps}
        >
          <span
            className="top-bar__mode-thumb"
            aria-hidden="true"
            data-active-index={props.topMode === 'work' ? '1' : '0'}
          />
          {TOP_MODES.map((mode) => {
            const active = props.topMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                className={`top-bar__mode-btn${active ? ' top-bar__mode-btn--active' : ''}`}
                aria-pressed={active}
                data-mode={mode.id}
                onClick={() => props.onTopModeChange?.(mode.id)}
                {...noDragProps}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="top-bar__right" {...noDragProps}>
        {props.collaborationSwitch}
        {props.right}
      </div>
    </header>
  );
}
