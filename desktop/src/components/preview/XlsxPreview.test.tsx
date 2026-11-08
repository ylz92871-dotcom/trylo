import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { utils, write } from 'xlsx';
import { XlsxPreview } from './XlsxPreview';
const mock = vi.hoisted(() => ({ state: { status: 'loading' } as Record<string, unknown> }));
vi.mock('./usePreviewBytes', () => ({ usePreviewBytes: () => mock.state }));
describe('spreadsheet preview recovery and completeness', () => {
  it('shows a read error instead of spinning forever', () => {
    mock.state = { status: 'error', message: 'missing workbook' };
    render(<XlsxPreview path="missing.xlsx" />);
    expect(screen.getByRole('alert').textContent).toContain('missing workbook');
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('lets users reach cells after row 200 and column T', () => {
    const book = utils.book_new();
    const sheet = utils.aoa_to_sheet([['first']]);
    sheet['Y236'] = { t: 's', v: 'last-cell' }; sheet['!ref'] = 'A1:Y240';
    utils.book_append_sheet(book, sheet, 'Wide');
    mock.state = { status: 'ready', bytes: new Uint8Array(write(book, { type: 'array', bookType: 'xlsx' })) };
    render(<XlsxPreview path="wide.xlsx" />);
    expect(screen.queryByText('last-cell')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一段行' }));
    fireEvent.click(screen.getByRole('button', { name: '后面列' }));
    expect(screen.getByText('last-cell')).toBeTruthy();
    expect(screen.getByText('Y')).toBeTruthy();
  });
});
