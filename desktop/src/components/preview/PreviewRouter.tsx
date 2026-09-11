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
import { previewKindFor } from './previewKind';
import { MarkdownPreview } from './MarkdownPreview';
import { HtmlPreview } from './HtmlPreview';
import { CsvPreview } from './CsvPreview';
import { ImagePreview } from './ImagePreview';
import { TextPreview } from './TextPreview';
import { DxfPreview } from './DxfPreview';

const PdfPreview = lazy(() =>
  import('./PdfPreview').then((m) => ({ default: m.PdfPreview })),
);
const DocxPreview = lazy(() =>
  import('./DocxPreview').then((m) => ({ default: m.DocxPreview })),
);
const XlsxPreview = lazy(() =>
  import('./XlsxPreview').then((m) => ({ default: m.XlsxPreview })),
);
const PptxPreview = lazy(() =>
  import('./PptxPreview').then((m) => ({ default: m.PptxPreview })),
);
const ModelPreview = lazy(() =>
  import('./ModelPreview').then((m) => ({ default: m.ModelPreview })),
);
// Gerber rides Node-core shims (string_decoder/Buffer via
// vite-plugin-node-polyfills) — lazy so the shims and the parser stay
// out of the main bundle until a Gerber file is actually peeked.
const GerberPreview = lazy(() =>
  import('./GerberPreview').then((m) => ({ default: m.GerberPreview })),
);

function lazyFallback(): ReactElement {
  return <div className="preview__empty">Loading viewer…</div>;
}

export interface PreviewRouterProps {
  readonly path: string;
  readonly content: string;
}

export function PreviewRouter(props: PreviewRouterProps): ReactElement {
  switch (previewKindFor(props.path)) {
    case 'markdown':
      return <MarkdownPreview content={props.content} />;
    case 'html':
      return <HtmlPreview content={props.content} title={props.path} />;
    case 'csv':
      return <CsvPreview path={props.path} content={props.content} />;
    case 'image':
      // Images are binary: the text `content` is unusable, so the
      // component loads bytes itself. (App skips the text read for
      // byte-backed kinds — see previewKindNeedsBytes.)
      return <ImagePreview path={props.path} />;
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
          <PdfPreview path={props.path} />
        </Suspense>
      );
    case 'docx':
      return (
        <Suspense fallback={lazyFallback()}>
          <DocxPreview path={props.path} />
        </Suspense>
      );
    case 'xlsx':
      return (
        <Suspense fallback={lazyFallback()}>
          <XlsxPreview path={props.path} />
        </Suspense>
      );
    case 'pptx':
      return (
        <Suspense fallback={lazyFallback()}>
          <PptxPreview path={props.path} />
        </Suspense>
      );
    case 'model3d':
      return (
        <Suspense fallback={lazyFallback()}>
          <ModelPreview path={props.path} />
        </Suspense>
      );
    case 'text':
      return <TextPreview content={props.content} />;
  }
}
