import { expect, it } from 'vitest';
import { notebookStaticHtml, parseNotebook } from './notebook';
it('reads all saved cells, image/HTML outputs and legacy v3 notebooks without running code', () => {
  const parsed = parseNotebook(JSON.stringify({ nbformat: 4, metadata: { language_info: { name: 'python' } }, cells: [{ cell_type: 'markdown', source: ['# Saved\n', 'text'] }, { cell_type: 'code', source: 'print(2)', execution_count: 3, outputs: [{ output_type: 'display_data', data: { 'image/png': 'aGVsbG8=' } }, { output_type: 'stream', text: ['2\n'] }] }] }));
  expect(parsed.cells).toHaveLength(2); expect(parsed.cells[0]!.source).toBe('# Saved\ntext'); expect(parsed.cells[1]!.outputs).toHaveLength(2);
  const legacy = parseNotebook(JSON.stringify({ nbformat: 3, worksheets: [{ cells: [{ cell_type: 'code', input: ['x=1'], outputs: [{ output_type: 'pyout', text: ['1'], html: '<b>1</b>' }] }] }] }));
  expect(legacy.cells[0]!.source).toBe('x=1'); expect(legacy.cells[0]!.outputs[0]!.data?.['text/html']).toBe('<b>1</b>');
  expect(() => parseNotebook('{"cells":[]}')).toThrow();
});
it('isolates saved HTML output and strips scripts, navigation, external images and application calls', () => {
  const html = notebookStaticHtml('<meta http-equiv="refresh" content="0;url=https://example.com"><script>window.__TAURI__.invoke()</script><table><tr><td onclick="alert(1)">saved</td></tr></table><a href="https://example.com">link</a><img src="file:///secret"><iframe src="http://ipc.localhost"></iframe>');
  expect(html).toContain('<table>'); expect(html).toContain('saved'); expect(html).toContain("default-src 'none'");
  expect(html).not.toContain('<script'); expect(html).not.toContain('onclick'); expect(html).not.toContain('http-equiv="refresh"'); expect(html).not.toContain('file:///'); expect(html).not.toContain('ipc.localhost');
});
