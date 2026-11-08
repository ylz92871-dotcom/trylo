import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LazyCodePreview } from './LazyCodePreview';
import { localResourcePath } from '../../host-adapter/preview/resource-path';
import { readPreviewResource } from '../../host-adapter/preview/resources';

export interface MarkdownPreviewProps {
  readonly content: string;
  readonly path?: string;
  readonly allowedRoot?: string;
  readonly onOpenFile?: (path: string) => void;
  readonly onOpenExternal?: (url: string) => void;
}
interface MarkdownNode { type?: string; value?: string; children?: MarkdownNode[]; data?: { hProperties?: Record<string, string> } }
const headingSlug = (value: string): string => value.trim().toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
function headingAnchors() {
  return (tree: MarkdownNode): void => {
    const used = new Map<string, number>();
    const text = (node: MarkdownNode): string => node.value ?? node.children?.map(text).join('') ?? '';
    const visit = (node: MarkdownNode): void => {
      if (node.type === 'heading') {
        const slug = headingSlug(text(node));
        const count = used.get(slug) ?? 0; used.set(slug, count + 1);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: `preview-md-${slug}${count ? `-${count}` : ''}` } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
function MarkdownImage({ src, alt, path, root }: { src?: string; alt?: string; path?: string; root?: string }): ReactElement {
  const [loaded, setLoaded] = useState({ source: '', url: '', error: false });
  const remote = !!src && /^(https?:|data:image\/)/i.test(src);
  useEffect(() => {
    if (!src || remote) return;
    let stale = false;
    let url: string | undefined;
    const target = path && root ? localResourcePath(path, root, src) : undefined;
    if (!target || !root) { setLoaded({ source: src, url: '', error: true }); return; }
    void readPreviewResource(target, root).then((bytes) => {
      if (stale) return;
      const extension = target.split('.').at(-1)?.toLowerCase();
      const mime: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime[extension ?? ''] ?? 'application/octet-stream' }));
      setLoaded({ source: src, url, error: false });
    }, () => { if (!stale) setLoaded({ source: src, url: '', error: true }); });
    return () => { stale = true; if (url) URL.revokeObjectURL(url); };
  }, [src, remote, path, root]);
  if (loaded.source === src && loaded.error) return <span className="preview__missing-image">{alt || '图片'} · 无法读取</span>;
  const url = remote ? src : loaded.source === src ? loaded.url : undefined;
  return url ? <img src={url} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setLoaded({ source: src ?? '', url: '', error: true })} /> : <span role="status">正在读取图片…</span>;
}

export function MarkdownPreview(props: MarkdownPreviewProps): ReactElement {
  const [source, setSource] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const plugins = useMemo(() => [remarkGfm, headingAnchors], []);
  return <div className="preview__paged">
    <div className="preview__toolbar" role="toolbar" aria-label="Markdown 视图">
      <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>阅读</button>
      <button type="button" aria-pressed={source} onClick={() => setSource(true)}>源码</button>
      {error && <span role="alert">{error}</span>}
    </div>
    {source ? <LazyCodePreview path={props.path ?? 'document.md'} content={props.content} /> : <div ref={container} className="preview__markdown" role="region" aria-label="Markdown preview">
      <ReactMarkdown remarkPlugins={plugins} urlTransform={(value, key) => key === 'src' && /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);/i.test(value) ? value : defaultUrlTransform(value)} components={{
        img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} path={props.path} root={props.allowedRoot} />,
        a: ({ href, children }) => <a href={href} onClick={(event) => {
          if (!href) { event.preventDefault(); return; }
          if (href.startsWith('#')) {
            event.preventDefault();
            let fragment = href.slice(1); try { fragment = decodeURIComponent(fragment); } catch { return; }
            container.current?.querySelector(`#${CSS.escape(`preview-md-${fragment}`)}`)?.scrollIntoView({ block: 'start' });
          } else if (/^https?:/i.test(href)) {
            if (props.onOpenExternal) { event.preventDefault(); props.onOpenExternal(href); }
          } else {
            event.preventDefault();
            const target = props.path && props.allowedRoot ? localResourcePath(props.path, props.allowedRoot, href) : undefined;
            if (target && props.onOpenFile) { setError(''); props.onOpenFile(target); }
            else setError('无法打开此链接，请检查文件是否位于当前项目。');
          }
        }} target={/^https?:/i.test(href ?? '') ? '_blank' : undefined} rel="noreferrer">{children}</a>,
      }}>{props.content}</ReactMarkdown>
    </div>}
  </div>;
}
