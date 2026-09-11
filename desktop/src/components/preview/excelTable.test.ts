// Trylo Desktop — excelTable unit tests. The workbook is built in
// memory with the same library, so no binary fixtures are needed.

import { describe, expect, it } from 'vitest';
import { utils, write, type WorkBook } from 'xlsx';
import { workbookToTables } from './excelTable';

function workbookBytes(workbook: WorkBook): Uint8Array {
  const out = write(workbook, { type: 'array', bookType: 'xlsx' });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

function sampleWorkbook(): WorkBook {
  const workbook = utils.book_new();
  const sheet = utils.aoa_to_sheet([
    ['Name', 'Qty', 'Price'],
    ['Bolt M8', 120, 0.35],
    ['Nut M8', 120, 0.12],
  ]);
  utils.book_append_sheet(workbook, sheet, 'BOM');
  return workbook;
}

describe('workbookToTables', () => {
  it('projects sheets into string tables with a header row', () => {
    const tables = workbookToTables(workbookBytes(sampleWorkbook()));
    expect(tables.sheets).toHaveLength(1);
    const sheet = tables.sheets[0];
    expect(sheet?.name).toBe('BOM');
    expect(sheet?.totalRows).toBe(3);
    expect(sheet?.folded).toBe(false);
    expect(sheet?.rows[0]).toEqual(['Name', 'Qty', 'Price']);
    expect(sheet?.rows[1]?.[0]).toBe('Bolt M8');
  });

  it('keeps Excel display formatting instead of raw values', () => {
    const workbook = utils.book_new();
    const sheet = utils.aoa_to_sheet([[0.5]]);
    sheet['A1'] = { t: 'n', v: 0.5, z: '0%' };
    utils.book_append_sheet(workbook, sheet, 'Fmt');
    const tables = workbookToTables(workbookBytes(workbook));
    expect(tables.sheets[0]?.rows[0]?.[0]).toBe('50%');
  });

  it('folds oversized sheets instead of rendering them whole', () => {
    const workbook = utils.book_new();
    const data: string[][] = [];
    for (let r = 0; r < 250; r += 1) data.push([`row-${r}`]);
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(data), 'Big');
    const tables = workbookToTables(workbookBytes(workbook));
    const sheet = tables.sheets[0];
    expect(sheet?.totalRows).toBe(250);
    expect(sheet?.folded).toBe(true);
    expect(sheet?.rows.length).toBeLessThanOrEqual(200);
  });

  it('survives garbage bytes without throwing', () => {
    // SheetJS is lenient: garbage parses to a junk one-cell sheet.
    // The contract is "never throws", not "zero sheets".
    expect(() => workbookToTables(new Uint8Array([0, 1, 2, 3, 4]))).not.toThrow();
  });
});
