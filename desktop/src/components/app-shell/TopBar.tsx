import { ChevronRight, MoreHorizontal, PanelLeftOpen, Search } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import type { TopLevelMode } from '../../host-adapter/types';
import { isInteractiveTitlebarTarget, toggleNativeWindowZoom } from '../../host-adapter/native-shell';
import { formatShortcut, isMacPlatform } from '../../utils/platform';
import { useLiquidIndicator } from '../../utils/use-liquid-indicator';
import { PartialTextTransition } from '../chat/PartialTextTransition';

export interface TopBarProps {
  readonly workspaceName: string;
  readonly conversationTitle?: string;
  readonly collapsed: boolean;
  readonly onToggleLeftRail: () => void;
  readonly topMode?: TopLevelMode;
  readonly onTopModeChange?: (mode: TopLevelMode) => void;
  readonly right?: ReactNode;
  readonly collaborationSwitch?: ReactNode;
  readonly onOpenCommandPalette?: () => void;
}

const TOP_MODES: readonly { readonly id: TopLevelMode; readonly label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'work', label: 'Work' },
];

export function TopBar(props: TopBarProps): ReactElement {
  const mac = isMacPlatform();
  const dragProps = mac ? { 'data-tauri-drag-region': '' } : undefined;
  const noDragProps = mac ? { 'data-tauri-drag-region': 'false' } : undefined;
  const headerRef = useRef<HTMLElement>(null);
  const modeSwitchRef = useRef<HTMLDivElement>(null);
  const modeThumbRef = useRef<HTMLSpanElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [compactRight, setCompactRight] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let rafId: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width <= 0) return;
      const next = width < 680;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setCompactRight((prev) => (prev === next ? prev : next));
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    if (!compactRight) setOverflowOpen(false);
  }, [compactRight]);

  useEffect(() => {
    if (!overflowOpen) return;
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !overflowRef.current?.contains(event.target)) {
        setOverflowOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOverflowOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [overflowOpen]);

  useLiquidIndicator({
    containerRef: modeSwitchRef,
    indicatorRef: modeThumbRef,
    activeKey: props.topMode,
    axis: 'x',
  });

  const onHeaderDoubleClick = (event: MouseEvent<HTMLElement>): void => {
    if (!mac || isInteractiveTitlebarTarget(event.target)) return;
    void toggleNativeWindowZoom();
  };

  return (
    <header
      ref={headerRef}
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
          <PartialTextTransition value={props.conversationTitle || '新任务'} dragRegion={mac ? '' : undefined} />
        </span>
      </div>

      {props.topMode && props.onTopModeChange && (
        <div
          ref={modeSwitchRef}
          className="top-bar__mode-switch"
          role="group"
          aria-label="工作模式"
          {...noDragProps}
        >
          <span
            ref={modeThumbRef}
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
                data-liquid-key={mode.id}
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
        {props.onOpenCommandPalette && (
          <button
            type="button"
            className="top-bar__rail-toggle"
            aria-label="命令面板"
            title={mac ? `命令面板 ${formatShortcut(['Mod', 'K'])}` : `命令面板 ${formatShortcut(['Mod', 'K'])}`}
            onClick={props.onOpenCommandPalette}
            {...noDragProps}
          >
            <Search size={15} strokeWidth={1.7} aria-hidden="true" />
          </button>
        )}
        {props.collaborationSwitch}
        {compactRight && props.right ? (
          <div ref={overflowRef} className="top-bar__overflow">
            <button
              type="button"
              className={`top-bar__rail-toggle${overflowOpen ? ' top-bar__rail-toggle--active' : ''}`}
              aria-label="更多工作台"
              title="更多工作台"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((open) => !open)}
              {...noDragProps}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            {overflowOpen && (
              <div className="top-bar__overflow-menu" role="menu" aria-label="工作台面板">
                {props.right}
              </div>
            )}
          </div>
        ) : (
          props.right
        )}
      </div>
    </header>
  );
}
