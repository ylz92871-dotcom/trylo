import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown, Clipboard, ExternalLink, Eye, FileText, FolderOpen, MoreHorizontal } from 'lucide-react';
import type { ArtifactHost, ExternalApplication } from '../../host-adapter/artifact-actions';
import { artifactCardCanPreview, type ArtifactCardKind } from '../../preview/formats';
import { artifactDenialText, isHttpArtifact, relativeArtifactPath, validateArtifactTarget } from '../../results/artifact-paths';
import { isMacPlatform } from '../../utils/platform';
import { pushToast } from '../feedback/toast-store';
import { ArtifactCardMenu, type ArtifactMenuAction } from './ArtifactCardMenu';

export interface ArtifactCardProps {
  readonly filePath: string;
  readonly kind: ArtifactCardKind;
  readonly workspacePath?: string;
  readonly host?: ArtifactHost;
  readonly onOpenViewer?: (path: string) => void;
  readonly onActionError?: (message: string, filePath: string) => void;
  readonly layout?: 'card' | 'row';
  /** Result-owned metadata and secondary actions share the same file row. */
  readonly metadata?: ReactNode;
  readonly secondaryAction?: ReactNode;
}

const EXTERNAL_APPLICATIONS_DEFAULT: Readonly<Record<ArtifactCardKind, readonly ExternalApplication[]>> = {
  document: [
    { identifier: 'winword', name: 'Microsoft Word' },
    { identifier: 'pages', name: 'Pages' },
    { identifier: 'textedit', name: 'TextEdit' },
  ],
  presentation: [
    { identifier: 'powerpnt', name: 'Microsoft PowerPoint' },
    { identifier: 'keynote', name: 'Keynote' },
    { identifier: 'soffice', name: 'LibreOffice Impress' },
    { identifier: 'preview', name: 'Preview' },
  ],
  spreadsheet: [
    { identifier: 'excel', name: 'Microsoft Excel' },
    { identifier: 'numbers', name: 'Numbers' },
    { identifier: 'outlook', name: 'Microsoft Outlook' },
  ],
  web: [],
  file: [],
};

const EXTERNAL_APPLICATIONS_MAC: Readonly<Record<ArtifactCardKind, readonly ExternalApplication[]>> = {
  document: [
    { identifier: 'Microsoft Word', name: 'Microsoft Word' },
    { identifier: 'Pages', name: 'Pages' },
    { identifier: 'LibreOffice', name: 'LibreOffice' },
    { identifier: 'TextEdit', name: 'TextEdit' },
  ],
  presentation: [
    { identifier: 'Microsoft PowerPoint', name: 'Microsoft PowerPoint' },
    { identifier: 'Keynote', name: 'Keynote' },
    { identifier: 'LibreOffice', name: 'LibreOffice' },
    { identifier: 'Preview', name: 'Preview' },
  ],
  spreadsheet: [
    { identifier: 'Microsoft Excel', name: 'Microsoft Excel' },
    { identifier: 'Numbers', name: 'Numbers' },
    { identifier: 'LibreOffice', name: 'LibreOffice' },
  ],
  web: [],
  file: [],
};

function externalApplicationsFor(kind: ArtifactCardKind, mac: boolean): readonly ExternalApplication[] {
  return (mac ? EXTERNAL_APPLICATIONS_MAC : EXTERNAL_APPLICATIONS_DEFAULT)[kind];
}

const FAMILY_LABELS: Readonly<Record<ArtifactCardKind, string>> = {
  document: 'document', presentation: 'presentation', spreadsheet: 'spreadsheet', web: 'web page', file: 'file',
};

/** A produced file uses the same preview catalog and native actions as Desktop. */
export function ArtifactCard(props: ArtifactCardProps): JSX.Element {
  const [failure, setFailure] = useState<string | null>(null);
  const [optionsVisible, setOptionsVisible] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOptionsVisible(false), []);
  const row = props.layout === 'row';
  const url = isHttpArtifact(props.filePath);
  const fileName = props.filePath.split(/[\\/]/).pop() ?? props.filePath;
  const displayPath = url ? props.filePath
    : relativeArtifactPath(props.filePath, props.workspacePath) ?? props.filePath.replace(/\\/g, '/');
  const directory = displayPath.includes('/') ? displayPath.slice(0, displayPath.lastIndexOf('/')) : '';
  const verdict = url
    ? { ok: true as const }
    : validateArtifactTarget(props.filePath, props.workspacePath);
  const denial = verdict.ok ? undefined : artifactDenialText(verdict.reason);

  const perform = (action: () => void | Promise<void>) => {
    setFailure(null);
    const report = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setFailure(message);
      props.onActionError?.(message, props.filePath);
    };
    try {
      void Promise.resolve(action()).catch(report);
    } catch (error) {
      report(error);
    }
  };
  const host = (): ArtifactHost => {
    if (!props.host) throw new Error('文件操作暂不可用，请重新连接桌面端。');
    return props.host;
  };
  const open = () => {
    dismiss();
    if (denial) return;
    perform(() => {
      // A URL's extension does not make it a project-local preview resource.
      if (!url && props.onOpenViewer && artifactCardCanPreview(props.kind, props.filePath)) {
        return props.onOpenViewer(props.filePath);
      } else {
        return host().openFile(props.filePath);
      }
    });
  };
  const copy: ArtifactMenuAction = {
    id: 'copy', label: row ? '复制路径' : 'Copy path', icon: Clipboard,
    run: () => perform(async () => {
      await host().copyToClipboard(props.filePath);
      pushToast({ id: 'copy-path', tone: 'success', title: '已复制文件路径' });
    }),
  };
  const mac = isMacPlatform();
  const canQuickLook = mac && !url && !denial && !!props.host?.quickLookFile;
  const preview = () => {
    dismiss();
    perform(() => props.host?.quickLookFile?.(props.filePath));
  };
  const previewOnSpace = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!canQuickLook || event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    if (!event.repeat) preview();
  };
  const options: ArtifactMenuAction[] = externalApplicationsFor(props.kind, mac).map((application) => ({
    id: application.identifier,
    label: application.name,
    disabled: !!denial,
    title: denial,
    run: () => perform(() => host().openFileWithApp(props.filePath, application)),
  }));
  if (canQuickLook) options.unshift({ id: 'quick-look', label: '快速预览', icon: Eye, run: preview });
  if (props.kind === 'web' || url) {
    options.push({ id: 'browser', label: row ? '在浏览器中打开' : 'Open in browser', icon: ExternalLink, disabled: !!denial, title: denial, run: open });
  }
  if (props.kind === 'web' || props.kind === 'file' || url) options.push(copy);
  if (!row || !url) options.push({
    id: 'folder', label: mac ? (row ? '在访达中显示' : 'Reveal in Finder') : (row ? '在文件夹中显示' : 'Open in folder'), icon: FolderOpen, separator: true,
    disabled: !!denial, title: denial,
    run: () => perform(() => host().showInFolder(props.filePath)),
  });

  return (
    <div className={`artifact-card artifact-card--${props.kind}${row ? ' artifact-card--row' : ''}`}>
      {row ? <button type="button" className="artifact-card__path"
        title={denial ?? props.filePath} aria-label={`${url ? '打开链接' : '打开文件'} ${displayPath}`}
        disabled={!!denial} onClick={open} onKeyDown={previewOnSpace} aria-keyshortcuts={canQuickLook ? "Space" : undefined}>
        {url ? <ExternalLink size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
        <span className="artifact-card__path-name">
          <span className="artifact-card__filename">{fileName}</span>
          {directory && <span className="artifact-card__directory">{directory}</span>}
        </span>
      </button> : <span className="artifact-card__name" title={denial ?? fileName}>{fileName}</span>}
      {row && <span className="artifact-card__metadata">{props.metadata}</span>}
      <div className="artifact-card__actions" ref={anchor}>
        {row ? props.secondaryAction : <button type="button" className="artifact-card__open" title={denial ?? `Open ${FAMILY_LABELS[props.kind]}`} disabled={!!denial} onClick={open} onKeyDown={previewOnSpace} aria-keyshortcuts={canQuickLook ? "Space" : undefined}>
          <ArrowUpRight size={14} strokeWidth={2} />
          <span>Open</span>
        </button>}
        <button type="button" className="artifact-card__menu-btn" title={row ? '更多操作' : 'Open options'} aria-label={row ? `${fileName} 的更多操作` : 'Open options'} aria-haspopup="menu" aria-expanded={optionsVisible} onClick={() => setOptionsVisible(!optionsVisible)}>
          {row ? <MoreHorizontal size={15} aria-hidden="true" /> : <ChevronDown size={14} strokeWidth={1.8} />}
        </button>
      </div>
      {optionsVisible && <ArtifactCardMenu anchor={anchor} actions={options} onDismiss={dismiss} />}
      {denial && <div className="artifact-card__denied" role="note">{denial}</div>}
      {failure !== null && <div className="artifact-card__error" role="alert">{failure}</div>}
    </div>
  );
}
