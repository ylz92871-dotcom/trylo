export interface NotebookOutput { kind: 'text' | 'display'; text?: string; data?: Record<string, unknown> }
export interface NotebookCell { kind: 'markdown' | 'code' | 'raw'; source: string; execution?: number; outputs: NotebookOutput[] }
export interface Notebook { language: string; cells: NotebookCell[] }
export function notebookText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join('');
  return '';
}
/** Read saved cells/outputs only. Nothing starts a kernel or executes a cell. */
export function parseNotebook(content: string): Notebook {
  if (content.length > 20 * 1024 * 1024) throw new Error('此笔记本超过 20 MB 阅读限制，请使用源码视图或外部应用');
  const data = JSON.parse(content) as Record<string, unknown>;
  if (!data || typeof data !== 'object' || ![3, 4].includes(Number(data.nbformat))) throw new Error('文件不是受支持的 Jupyter 笔记本');
  const metadata = data.metadata as { language_info?: { name?: string }; kernelspec?: { language?: string } } | undefined;
  const language = metadata?.language_info?.name ?? metadata?.kernelspec?.language ?? 'python';
  const input = data.nbformat === 3 && Array.isArray(data.worksheets) ? data.worksheets.flatMap((sheet: { cells?: unknown[] }) => sheet.cells ?? []) : data.cells;
  if (!Array.isArray(input) || input.length > 10000) throw new Error('笔记本单元列表无效或超过 10,000 个单元');
  const cells = input.map((value): NotebookCell => {
    const cell = value as Record<string, unknown>;
    if (!cell || typeof cell !== 'object') throw new Error('笔记本单元无效');
    const kind = cell.cell_type === 'markdown' || cell.cell_type === 'heading' ? 'markdown' : cell.cell_type === 'code' ? 'code' : 'raw';
    let source = notebookText(cell.source ?? cell.input);
    if (cell.cell_type === 'heading') source = `${'#'.repeat(Math.max(1, Math.min(6, Number(cell.level) || 1)))} ${source}`;
    const outputs: NotebookOutput[] = (Array.isArray(cell.outputs) ? cell.outputs : []).map((value) => {
      const output = value as Record<string, unknown>;
      if (output.output_type === 'error' || output.output_type === 'pyerr') return { kind: 'text', text: notebookText(output.traceback) || `${notebookText(output.ename)}: ${notebookText(output.evalue)}` };
      if (output.output_type === 'stream') return { kind: 'text', text: notebookText(output.text) };
      const legacy = Object.fromEntries(['png', 'jpeg', 'svg', 'html', 'text'].filter((key) => output[key] !== undefined).map((key) => [key === 'text' ? 'text/plain' : key === 'html' ? 'text/html' : `image/${key === 'svg' ? 'svg+xml' : key}`, output[key]]));
      return { kind: 'display', data: output.data && typeof output.data === 'object' ? output.data as Record<string, unknown> : legacy };
    });
    return { kind, source, execution: typeof (cell.execution_count ?? cell.prompt_number) === 'number' ? Number(cell.execution_count ?? cell.prompt_number) : undefined, outputs };
  });
  return { language: typeof language === 'string' ? language : 'python', cells };
}
export function notebookStaticHtml(content: string): string {
  const document = new DOMParser().parseFromString(content, 'text/html');
  document.querySelectorAll('script,iframe,frame,object,embed,base,meta,link,form,input,button,textarea,select').forEach((node) => node.remove());
  document.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ['href', 'srcset', 'action', 'formaction', 'xlink:href'].includes(attribute.name.toLowerCase()) || (attribute.name.toLowerCase() === 'src' && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(attribute.value))) node.removeAttribute(attribute.name);
    }
  });
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>body{font:14px system-ui,sans-serif;color:#27272a;background:#fff;margin:12px}table{border-collapse:collapse;max-width:100%}td,th{padding:6px 10px;border:1px solid #ddd}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style>${document.head.innerHTML}</head><body>${document.body.innerHTML}</body></html>`;
}
