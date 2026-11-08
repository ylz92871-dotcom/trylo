// Trylo Desktop — PreviewRouter (base capability).
//
// Single routing point from (path, content) to the rich preview.
// FilePeek is the ONLY caller: Code file-tree clicks, Code result
// opens, and Work artifact opens all land here, so both modes stay in
// lockstep by construction.
//
// Bundle discipline: the heavy vendor renderers (PDF / Office / 3D /
// Gerber) load LAZILY — opening the app never pays for pdf.js /
// three.js / SheetJS / Node-core shims until a matching file is
// actually peeked. The light views (markdown / html / table / image /
// text / dxf) stay synchronous; dxf-parser is small and browser-clean.
//
// To add a format: extend `previewKindFor`, add `XxxPreview.tsx`,
// add one branch below (lazy if the vendor lib is heavy).

import type { ReactElement } from 'react';
import { Suspense, lazy } from 'react';
import { previewKindFor, type PreviewKind } from './previewKind';
import { sourceLanguageFor } from '../../preview/languages';
import { MarkdownPreview } from './MarkdownPreview';
import { HtmlPreview } from './HtmlPreview';
import { CsvPreview } from './CsvPreview';
import { ImagePreview } from './ImagePreview';
import { TextPreview } from './TextPreview';
import { LazyCodePreview } from './LazyCodePreview';
import { DxfPreview } from './DxfPreview';
import { MediaPreview } from './MediaPreview';

const PdfPreview = lazy(() =>
  import('./PdfPreview').then((m) => ({ default: m.PdfPreview })),
);
const OfficePreview = lazy(() => import('./OfficePreview').then((m) => ({ default: m.OfficePreview })));
const ModelPreview = lazy(() =>
  import('./ModelPreview').then((m) => ({ default: m.ModelPreview })),
);
// Gerber rides Node-core shims (string_decoder/Buffer via
// vite-plugin-node-polyfills) — lazy so the shims and the parser stay
// out of the main bundle until a Gerber file is actually peeked.
const GerberPreview = lazy(() =>
  import('./GerberPreview').then((m) => ({ default: m.GerberPreview })),
);
const NotebookPreview = lazy(() => import('./NotebookPreview').then((m) => ({ default: m.NotebookPreview })));
const FontPreview = lazy(() => import('./FontPreview').then((m) => ({ default: m.FontPreview })));
const ArchivePreview = lazy(() => import('./ArchivePreview').then((m) => ({ default: m.ArchivePreview })));

function lazyFallback(): ReactElement {
  return <div className="preview__empty">Loading viewer…</div>;
}

export interface PreviewRouterProps {
  readonly path: string;
  readonly content: string;
  readonly allowedRoot?: string;
  readonly resolvedKind?: PreviewKind;
  readonly onOpenFile?: (path: string) => void;
  readonly onOpenExternal?: (url: string) => void;
}

export function PreviewRouter(props: PreviewRouterProps): ReactElement {
  const kind = props.resolvedKind ?? previewKindFor(props.path);
  switch (kind) {
    case 'notebook': return <Suspense fallback={lazyFallback()}><NotebookPreview key={props.path} {...props} /></Suspense>;
    case 'font': return <Suspense fallback={lazyFallback()}><FontPreview key={props.path} path={props.path} allowedRoot={props.allowedRoot} /></Suspense>;
    case 'archive': return <Suspense fallback={lazyFallback()}><ArchivePreview key={props.path} path={props.path} allowedRoot={props.allowedRoot} /></Suspense>;
    case 'markdown':
      return <MarkdownPreview key={props.path} content={props.content} path={props.path} allowedRoot={props.allowedRoot} onOpenFile={props.onOpenFile} onOpenExternal={props.onOpenExternal} />;
    case 'html':
      return <HtmlPreview key={props.path} content={props.content} title={props.path} allowedRoot={props.allowedRoot} />;
    case 'csv':
      return <CsvPreview key={props.path} path={props.path} content={props.content} />;
    case 'image':
      // Images are binary: the text `content` is unusable, so the
      // component loads bytes itself. (App skips the text read for
      // byte-backed kinds — see previewKindNeedsBytes.)
      return <ImagePreview key={props.path} path={props.path} allowedRoot={props.allowedRoot} />;
    case 'audio':
    case 'video':
      return <MediaPreview key={props.path} path={props.path} allowedRoot={props.allowedRoot} kind={kind} />;
    case 'dxf':
      return <DxfPreview content={props.content} />;
    case 'gerber':
      return (
        <Suspense fallback={lazyFallback()}>
          <GerberPreview path={props.path} content={props.content} />
        </Suspense>
      );
    case 'pdf':
      return (
        <Suspense fallback={lazyFallback()}>
          <PdfPreview path={props.path} allowedRoot={props.allowedRoot} />
        </Suspense>
      );
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'office':
      return (
        <Suspense fallback={lazyFallback()}>
          <OfficePreview key={props.path} path={props.path} allowedRoot={props.allowedRoot} kind={previewKindFor(props.path) as 'docx' | 'xlsx' | 'pptx' | 'office'} />
        </Suspense>
      );
    case 'unsupported': return <div className="preview__empty">此格式暂不支持应用内预览。请使用右上角的外部打开或文件夹操作查看原文件。</div>;
    case 'model3d':
      return (
        <Suspense fallback={lazyFallback()}>
          <ModelPreview path={props.path} allowedRoot={props.allowedRoot} />
        </Suspense>
      );
    case 'code':
      if (props.content.includes('\u0000')) return <div className="preview__empty">此文件包含二进制内容，请使用外部应用打开。</div>;
      return <LazyCodePreview key={props.path} path={props.path} content={props.content} />;
    case 'text':
      if (props.content.includes('\u0000')) return <div className="preview__empty">此文件包含二进制内容，请使用外部应用打开。</div>;
      if (sourceLanguageFor(props.path, props.content).id !== 'plaintext') return <LazyCodePreview key={props.path} path={props.path} content={props.content} />;
      return <TextPreview key={props.path} content={props.content} />;
  }
}
