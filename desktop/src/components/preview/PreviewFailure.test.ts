import { describe, it, expect } from 'vitest';
import { previewErrorMessage } from './PreviewFailure';
describe('preview failure copy', () => {
  it('explains missing files and corrupt PDFs without discarding diagnostics', () => {
    expect(previewErrorMessage('dev fs stat_file 500: ENOENT missing.xlsx')).toContain('找不到文件');
    expect(previewErrorMessage('InvalidPDFException: Invalid PDF structure.')).toContain('PDF 无法解析');
    expect(previewErrorMessage('页面预览需要本机安装 LibreOffice')).toContain('LibreOffice');
  });
});
