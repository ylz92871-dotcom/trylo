// The host owns the comparison data. This surface owns only reading state.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type * as Monaco from 'monaco-editor';
import { ChevronDown, ChevronUp, FileDiff, FoldVertical, Maximize2, Minimize2, X } from 'lucide-react';
import { captureFocus, restoreFocus } from '../../a11y/focus-return';
import { useAppearance } from '../../settings/appearance-store';
import { initMonaco } from '../../monaco-init';
import { sourceLanguageFor } from '../../preview/languages';
import { registerPreviewLanguages } from '../../preview/providers/source-highlighting';
import { SourceReaderTools, useReaderNotice } from '../preview/SourceReaderTools';
import { editorReadingOptions, editorTheme, registerEditorAppearance } from './editorAppearance';

export interface GitFileDiffData {
  readonly original: string; readonly modified: string; readonly binary: boolean; readonly truncated: boolean;
}
export interface GitDiffViewProps {
  readonly path: string; readonly diff?: GitFileDiffData; readonly error?: string;
  readonly notice?: string; readonly onClose: () => void;
}
type Layout = 'auto' | 'inline' | 'split';
export function GitDiffView(props: GitDiffViewProps): ReactElement {
  const { diff, error, path } = props;
  const { theme } = useAppearance();
  const root = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null);
  const reader = useRef<Monaco.editor.IStandaloneDiffEditor>();
  const api = useRef<typeof Monaco>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [revision, setRevision] = useState(0), [expanded, setExpanded] = useState(false);
  const [layout, setLayout] = useState<Layout>('auto'), [wide, setWide] = useState(false);
  const [wrap, setWrap] = useState(false), [fold, setFold] = useState(true);
  const [changes, setChanges] = useState<Monaco.editor.ILineChange[]>([]);
  const [computing, setComputing] = useState(true), [active, setActive] = useState(-1);
  const [notice, setNotice] = useReaderNotice();
  const latest = useRef({ ...props, theme, expanded, layout, wide, wrap, fold });
  latest.current = { ...props, theme, expanded, layout, wide, wrap, fold };
  const usable = !!diff && !diff.binary && !diff.truncated && error === undefined;
  const split = layout === 'split' || (layout === 'auto' && wide);
  const language = sourceLanguageFor(path, diff?.modified || diff?.original || '');
  const totals = useMemo(() => changes.reduce((sum, change) => ({
    added: sum.added + (change.modifiedEndLineNumber ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1 : 0),
    removed: sum.removed + (change.originalEndLineNumber ? change.originalEndLineNumber - change.originalStartLineNumber + 1 : 0),
  }), { added: 0, removed: 0 }), [changes]);
  const close = (): void => { restoreFocus(); latest.current.onClose(); };
  useEffect(() => {
    captureFocus();
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || root.current?.closest('[hidden]')) return;
      event.preventDefault(); event.stopPropagation();
      if (latest.current.expanded) setExpanded(false);
      else { restoreFocus(); latest.current.onClose(); }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => { setExpanded(false); setNotice(''); }, [path]);
  useEffect(() => {
    const element = container.current;
    if (!usable || !element) return;
    const measure = (): void => setWide(element.clientWidth >= 760);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [usable, path, revision]);
  useEffect(() => {
    if (!usable || !container.current) return;
    let cancelled = false;
    let instance: Monaco.editor.IStandaloneDiffEditor | undefined;
    let original: Monaco.editor.ITextModel | undefined, modified: Monaco.editor.ITextModel | undefined;
    setStatus('loading'); setComputing(true); setChanges([]); setActive(-1);
    void initMonaco().then(() => import('monaco-editor')).then(monaco => {
      if (cancelled || !container.current || !latest.current.diff) return;
      api.current = monaco; registerEditorAppearance(monaco); registerPreviewLanguages(monaco);
      const current = latest.current, data = current.diff!;
      const source = sourceLanguageFor(current.path, data.modified || data.original).id;
      original = monaco.editor.createModel(data.original, source);
      modified = monaco.editor.createModel(data.modified, source);
      instance = monaco.editor.createDiffEditor(container.current, {
        ...editorReadingOptions, theme: editorTheme(current.theme), automaticLayout: true,
        readOnly: true, domReadOnly: true, originalEditable: false,
        renderSideBySide: current.layout === 'split' || (current.layout === 'auto' && current.wide),
        renderSideBySideInlineBreakpoint: 0, useInlineViewWhenSpaceIsLimited: false,
        renderMarginRevertIcon: false, renderOverviewRuler: false,
        renderValidationDecorations: 'off', links: false,
        hideUnchangedRegions: { enabled: current.fold, contextLineCount: 3, minimumLineCount: 8 },
        wordWrap: current.wrap ? 'on' : 'off', diffWordWrap: current.wrap ? 'on' : 'off',
      });
      reader.current = instance;
      instance.onDidUpdateDiff(() => {
        if (cancelled) return;
        const result = instance?.getLineChanges();
        if (result) { setChanges(result); setComputing(false); }
      });
      instance.setModel({ original, modified });
      setStatus('ready');
    }).catch(() => {
      if (!cancelled) {
        instance?.dispose(); original?.dispose(); modified?.dispose();
        instance = undefined; original = undefined; modified = undefined;
        reader.current = undefined; api.current = undefined; setStatus('error');
      }
    });
    return () => { cancelled = true; instance?.dispose(); original?.dispose(); modified?.dispose(); reader.current = undefined; api.current = undefined; };
  }, [usable, path, revision]);
  useEffect(() => {
    const instance = reader.current, monaco = api.current, model = instance?.getModel();
    if (!instance || !monaco || !model || !diff || status !== 'ready') return;
    monaco.editor.setTheme(editorTheme(theme));
    if (model.original.getValue() !== diff.original || model.modified.getValue() !== diff.modified) {
      setComputing(true); setActive(-1);
      model.original.setValue(diff.original); model.modified.setValue(diff.modified);
    }
    instance.updateOptions({ renderSideBySide: split, wordWrap: wrap ? 'on' : 'off', diffWordWrap: wrap ? 'on' : 'off', hideUnchangedRegions: { enabled: fold } });
  }, [diff, status, split, wrap, fold, theme]);
  const navigate = (direction: number): void => {
    if (!changes.length) return;
    const index = active < 0 ? direction > 0 ? 0 : changes.length - 1 : (active + direction + changes.length) % changes.length;
    const change = changes[index]!, editor = reader.current?.getModifiedEditor();
    const line = Math.max(1, Math.min(editor?.getModel()?.getLineCount() ?? 1, change.modifiedEndLineNumber ? change.modifiedStartLineNumber : change.modifiedStartLineNumber + 1));
    setActive(index); editor?.revealLineInCenter(line); editor?.setPosition({ lineNumber: line, column: 1 }); editor?.focus();
  };
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(diff?.modified ?? ''); setNotice('已复制修改后内容'); }
    catch { setNotice('复制失败，请在对比视图中选中后复制。'); }
  };
  const loading = diff === undefined && error === undefined;
  return <div ref={root} className={`git-diff-view source-reader${expanded ? ' git-diff-view--expanded' : ''}`} role="region" aria-label={`Diff for ${path}`}>
    <header className="git-diff-view__head"><FileDiff size={17} strokeWidth={1.6} aria-hidden="true" />
      <span className="git-diff-view__path" title={path}>{path}</span>
      {usable && !computing && <span className="git-diff-view__stats" aria-label={`新增 ${totals.added} 行，删除 ${totals.removed} 行`}><span>+{totals.added}</span><span>−{totals.removed}</span></span>}
      <button type="button" className="git-diff-view__icon" title={expanded ? '退出展开' : '展开对比'} aria-label={expanded ? '退出展开对比' : '展开对比'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      <button type="button" className="git-diff-view__icon" title="关闭对比" onClick={close} aria-label="Close diff"><X size={15} /></button>
    </header>
    {props.notice && <p className="git-diff-view__notice" role="status" aria-label="变更说明">{props.notice}</p>}
    {usable && <div className="git-diff-view__controls">
      <select aria-label="对比布局" value={layout} onChange={event => setLayout(event.target.value as Layout)}><option value="auto">自动：{split ? '并排' : '行内'}</option><option value="inline">行内对比</option><option value="split">并排对比</option></select>
      <button type="button" aria-label="折叠未改动" title="折叠未改动" aria-pressed={fold} onClick={() => setFold(value => !value)}><FoldVertical size={14} /><span className="git-diff-view__fold-label">折叠未改动</span></button>
      <span className="git-diff-view__change-count">{computing ? '计算中…' : changes.length ? active >= 0 ? `${active + 1} / ${changes.length}` : `${changes.length} 处变更` : '内容一致'}</span>
      <button type="button" aria-label="上一处变更" title="上一处变更" disabled={!changes.length || computing} onClick={() => navigate(-1)}><ChevronUp size={14} /></button>
      <button type="button" aria-label="下一处变更" title="下一处变更" disabled={!changes.length || computing} onClick={() => navigate(1)}><ChevronDown size={14} /></button>
    </div>}
    {usable && split && <div className="git-diff-view__sides"><span>原始内容</span><span>修改后</span></div>}
    <div className="git-diff-view__body">
      {usable && <><div ref={container} className="git-diff-view__monaco" />
        {status === 'loading' && <div className="source-reader__loading" role="status" aria-label="加载对比编辑器"><span className="preview__spinner" />正在准备变更对比…</div>}
        {status === 'error' && <div className="source-reader__empty" role="alert"><FileDiff size={27} /><strong>对比编辑器未能加载</strong><span>文件内容仍在，请重试。</span><button type="button" onClick={() => setRevision(value => value + 1)}>重新加载对比</button></div>}
      </>}
      {!usable && <div className="source-reader__empty" role="status" aria-label={loading ? '加载变更' : '变更状态'}>
        {loading ? <><span className="preview__spinner" /><strong>正在加载变更…</strong></> : <><FileDiff size={27} /><strong>{error !== undefined ? '无法加载此文件的变更' : diff?.binary ? '二进制文件无法显示文本差异' : '文件过大，未提供完整差异'}</strong><span>{error ?? (diff?.binary ? '请使用文件预览查看内容。' : '请在外部编辑器中查看完整文件。')}</span></>}
      </div>}
    </div>
    {usable && <SourceReaderTools wrap={wrap} onWrap={() => setWrap(value => !value)} ready={status === 'ready'} notice={notice} onCopy={() => void copy()} copyLabel="复制修改后内容"
      onFind={() => { const editor = reader.current?.getModifiedEditor(); editor?.focus(); void editor?.getAction('actions.find')?.run(); }}><span>{language.label}</span><span>变更对比</span></SourceReaderTools>}
  </div>;
}
