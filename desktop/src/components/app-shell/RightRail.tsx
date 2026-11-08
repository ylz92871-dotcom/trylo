// Trylo Desktop — RightRail. v1.17.
//
// The file tree, formerly crammed into the left rail's middle
// section, now lives here: a toggleable right-side panel. This
// is "Option A" from the UI redesign — keep the left rail
// focused on workspaces + conversation history, and give the
// file tree its own collapsible home so it doesn't fight for
// vertical space with the session list.
//
// The tree itself is the existing WorkspaceTree component, so
// behaviour (lazy loading, refresh, error states) is unchanged.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Maximize2, X } from 'lucide-react';
import type { FilePath } from '../../host-adapter/types';
import { WorkspaceTree } from './WorkspaceTree';

export interface RightRailReview {
  readonly id: string;
  readonly label?: string;
  readonly open: boolean;
  readonly content: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
}

export interface RightRailProps {
  readonly review?: RightRailReview;
  readonly maxWidth?: number;
  readonly preview?: ReactNode;
  readonly previewKey?: string | null;
  readonly onExpandPreview?: () => void;
  /** Whether the panel is visible. When false, render nothing. */
  readonly open: boolean;
  /** The workspace root whose files are shown. */
  readonly root: FilePath | null;
  /** Hide the panel. */
  readonly onClose: () => void;
  /** Click a file/folder in the tree. */
  readonly onSelectFile?: (path: FilePath, kind: 'file' | 'dir') => void;
}

export function RightRail(props: RightRailProps): ReactElement | null {
  const [tab, setTab] = useState<'files' | 'preview'>(props.previewKey ? 'preview' : 'files');
  const previousPreview = useRef(props.previewKey);
  const previewFromReview = useRef<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const activeTab = props.review?.open ? 'review' : tab;
  useEffect(() => {
    if (props.previewKey && props.previewKey !== previousPreview.current) {
      previewFromReview.current = props.review?.open ? props.review.id : null;
      if (panelRef.current?.querySelector('.right-rail__review')?.contains(document.activeElement)) {
        panelRef.current.querySelector<HTMLButtonElement>('#result-preview-tab')?.focus();
      }
      setTab('preview');
      props.review?.onOpenChange(false);
    } else if (!props.previewKey && previousPreview.current) {
      if (props.open && props.review && previewFromReview.current === props.review.id) props.review.onOpenChange(true);
      previewFromReview.current = null;
    }
    previousPreview.current = props.previewKey;
  }, [props.previewKey, props.review, props.open]);
  useEffect(() => {
    if (props.open && props.review?.open) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !panelRef.current?.contains(active)) {
        if (active !== document.body) openerRef.current = active;
        closeRef.current?.focus();
      }
    } else if (!props.open && openerRef.current) {
      if (openerRef.current.isConnected) openerRef.current.focus();
      openerRef.current = null;
    }
  }, [props.open, props.review?.open]);
  if (!props.open) return null;

  const selectTab = (next: 'review' | 'preview' | 'files'): void => {
    if (next !== 'review') setTab(next);
    props.review?.onOpenChange(next === 'review');
  };
  const handleTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  return (
    <aside ref={panelRef} className={`right-rail${props.review ? ' right-rail--reviewable' : ''}`} aria-label="结果侧栏" data-view={activeTab}
      style={props.maxWidth !== undefined ? { maxWidth: props.maxWidth, '--rail-content-max': `${props.maxWidth}px` } as CSSProperties : undefined}
      onKeyDown={event => {
        if (event.key === 'Escape' && activeTab === 'review') {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}>
      <div className="right-rail__header">
      <div className="right-rail__tabs" role="tablist" aria-label="结果视图" onKeyDown={handleTabKey}>
        {props.review && <button id={`${props.review.id}-tab`} type="button" role="tab" tabIndex={activeTab === 'review' ? 0 : -1} aria-selected={activeTab === 'review'} aria-controls={props.review.id} onClick={() => selectTab('review')}>{props.review.label ?? '变更'}</button>}
        <button id="result-preview-tab" type="button" role="tab" tabIndex={activeTab === 'preview' ? 0 : -1} aria-selected={activeTab === 'preview'} aria-controls="result-preview" onClick={() => selectTab('preview')}>预览</button>
        <button id="result-files-tab" type="button" role="tab" tabIndex={activeTab === 'files' ? 0 : -1} aria-selected={activeTab === 'files'} aria-controls="result-files" onClick={() => selectTab('files')}>文件</button>
      </div>
        {props.onExpandPreview && activeTab === 'preview' && <button type="button" className="right-rail__close" aria-label="放大文件预览" title="放大文件预览" onClick={props.onExpandPreview}><Maximize2 size={15} /></button>}
        <button
          ref={closeRef}
          type="button"
          className="right-rail__close"
          onClick={props.onClose}
          title="收起面板"
          aria-label="收起面板"
        >
          <X size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      {props.review && <div id={props.review.id} className="right-rail__body right-rail__review" role="tabpanel" aria-labelledby={`${props.review.id}-tab`} hidden={activeTab !== 'review'}>
        {props.review.content}
      </div>}
      <div id="result-preview" className="right-rail__body right-rail__preview" role="tabpanel" aria-labelledby="result-preview-tab" hidden={activeTab !== 'preview'}>
        {props.preview ?? <div className="right-rail__empty">选择文件或对话中的结果，在这里查看。</div>}
      </div>
      <div id="result-files" className="right-rail__body" role="tabpanel" aria-labelledby="result-files-tab" hidden={activeTab !== 'files'}>
        {props.root ? <WorkspaceTree root={props.root} onSelect={(path, kind) => {
          if (kind === 'file') selectTab('preview');
          props.onSelectFile?.(path, kind);
        }} /> : <div className="right-rail__empty">打开项目后即可查看文件。</div>}
      </div>
    </aside>
  );
}
