// Trylo Desktop — preview barrel. FilePeek imports from here.
//
// Bundle discipline: value-export ONLY the light modules. The heavy
// vendor renderers (Pdf/Docx/Xlsx/Pptx/Model) are React.lazy-loaded
// inside PreviewRouter — re-exporting them here would pull pdf.js /
// three.js / SheetJS into the main bundle. Their prop TYPES are safe
// to export (erased at compile).

export { previewKindFor, previewExtOf, previewKindLabel, previewKindNeedsBytes } from './previewKind';
export type { PreviewKind } from './previewKind';
export { parseDelimited, delimiterFor } from './csvParse';
export type { ParsedCsv } from './csvParse';
// excelTable is type-only here on purpose: it imports SheetJS, which
// must stay inside the lazy XlsxPreview chunk, not the main bundle.
export type { SheetTable, WorkbookTables } from './excelTable';
export { dxfToSvg } from './dxfSvg';
export type { DxfSvg } from './dxfSvg';
// gerberSvg is NOT re-exported here on purpose: it imports
// gerber-to-svg (Node-core shims) and must stay inside the lazy
// GerberPreview chunk. Import it relatively (see GerberPreview).
export { usePreviewBytes } from './usePreviewBytes';
export type { PreviewBytesState } from './usePreviewBytes';
export { PreviewRouter } from './PreviewRouter';
export type { PreviewRouterProps } from './PreviewRouter';
export { MarkdownPreview } from './MarkdownPreview';
export { HtmlPreview } from './HtmlPreview';
export { CsvPreview } from './CsvPreview';
export { ImagePreview } from './ImagePreview';
export { TextPreview } from './TextPreview';
export { DxfPreview } from './DxfPreview';
// GerberPreview is type-only here on purpose: it needs Node-core shims
// and must stay inside its lazy chunk, not the main bundle.
export type { GerberPreviewProps } from './GerberPreview';
export type { PdfPreviewProps } from './PdfPreview';
export type { DocxPreviewProps } from './DocxPreview';
export type { XlsxPreviewProps } from './XlsxPreview';
export type { PptxPreviewProps } from './PptxPreview';
export type { ModelPreviewProps } from './ModelPreview';
