import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type * as monaco from 'monaco-editor';
import { initMonaco } from '../../monaco-init';
import { SOURCE_LANGUAGES, sourceLanguageFor } from '../../preview/languages';
import { registerPreviewLanguages } from '../../preview/providers/source-highlighting';
import { editorReadingOptions, editorTheme, registerEditorAppearance } from '../code-surface/editorAppearance';
import { useAppearance } from '../../settings/appearance-store';
import { SourceReaderTools, useReaderNotice } from './SourceReaderTools';
import { TextPreview } from './TextPreview';

/** Independent read-only model; never joins the editable document bridge. */
export function CodePreview({ path, content }: { path: string; content: string }): ReactElement {
  const { theme } = useAppearance();
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const apiRef = useRef<typeof monaco | null>(null);
  const [language, setLanguage] = useState(() => sourceLanguageFor(path, content).id);
  const [wrap, setWrap] = useState(false);
  const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useReaderNotice();
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const large = content.length > 8 * 1024 * 1024;
  const lineCount = useMemo(() => content.split('\n').length, [content]);
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(content); setNotice('已复制全文'); }
    catch { setNotice('复制失败，请在阅读器内选中后复制。'); }
  };
  useEffect(() => {
    if (large) return;
    setStatus('loading'); setLoadError(''); setNotice(''); setPosition({ lineNumber: 1, column: 1 });
    setLanguage(sourceLanguageFor(path, content).id);
    let disposed = false;
    let model: monaco.editor.ITextModel | undefined;
    void initMonaco().then(() => import('monaco-editor')).then((api) => {
      if (disposed || !container.current) return;
      apiRef.current = api;
      registerPreviewLanguages(api); registerEditorAppearance(api);
      model = api.editor.createModel(content, sourceLanguageFor(path, content).id);
      editor.current = api.editor.create(container.current, {
        ...editorReadingOptions, model, readOnly: true, domReadOnly: true, automaticLayout: true,
        theme: editorTheme(theme), wordWrap: 'off', renderValidationDecorations: 'off', links: false,
        ariaLabel: '代码预览，只读', contextmenu: true,
      });
      editor.current.onDidChangeCursorPosition(event => setPosition(event.position));
      setStatus('ready');
    }).catch((error: unknown) => {
      if (disposed) return;
      editor.current?.dispose(); editor.current = null; apiRef.current = null;
      model?.dispose(); model = undefined;
      console.warn('[CodePreview] Highlighter initialization failed', error);
      setLoadError(error instanceof Error ? error.message : String(error));
      setStatus('error');
    });
    return () => { disposed = true; editor.current?.dispose(); editor.current = null; apiRef.current = null; model?.dispose(); };
    // Content/theme changes update the existing model without losing selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, large, revision]);
  useEffect(() => {
    const api = apiRef.current;
    const model = editor.current?.getModel();
    if (status !== 'ready' || !api || !model) return;
    api.editor.setModelLanguage(model, language);
    api.editor.setTheme(editorTheme(theme));
    editor.current?.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
    if (model.getValue() !== content) model.setValue(content);
  }, [language, wrap, theme, content, status]);
  if (large || status === 'error') return <div className="preview__paged">
    {large ? <p className="preview__reader-notice" role="status">此文件较大，使用全文阅读模式；查找、跳行和复制仍可用。</p> : <div className="source-reader__recovery">
      <div className="source-reader__recovery-row"><p role="status">高亮阅读器未能加载，已切换为全文阅读。</p>
        <button type="button" onClick={() => { setStatus('loading'); setRevision(value => value + 1); }}>重试高亮</button>
      </div>
      <details><summary>错误详情</summary><pre>{loadError}</pre></details>
    </div>}
    <TextPreview content={content} />
  </div>;
  return <div className="source-reader" role="region" aria-label="代码阅读器" aria-busy={status === 'loading'}>
    <div className="source-reader__stage">
      <div ref={container} className="preview__code-editor" />
      {status === 'loading' && <div className="source-reader__loading" role="status"><span className="preview__spinner" />正在加载代码…</div>}
    </div>
    <SourceReaderTools lines={lineCount} position={position} wrap={wrap} onWrap={() => setWrap(value => !value)} ready={status === 'ready'} notice={notice}
      onFind={() => { editor.current?.focus(); void editor.current?.getAction('actions.find')?.run(); }} onCopy={() => void copy()}
      onGoTo={line => { editor.current?.revealLineInCenter(line); editor.current?.setPosition({ lineNumber: line, column: 1 }); editor.current?.focus(); }}>
      <select className="source-reader__language" aria-label="代码语言" value={language} onChange={event => setLanguage(event.target.value)}>
        {SOURCE_LANGUAGES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </SourceReaderTools>
  </div>;
}
