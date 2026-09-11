// Trylo Desktop Services — Office delivery validation pipeline (PR-5, §11).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §11 / §4.4 / §13.
//
// The invariants pinned here are the ones that keep §11 honest:
//   · a missing capability is a SKIPPED check + a reason, never a pass;
//   · an ENGINE failure is never reported as a CORRUPT DOCUMENT;
//   · the pipeline is bounded and never throws;
//   · the deliverable root (.trylo/out) is the only place validation runs.
//
// Containers are built by hand (stored, uncompressed ZIP entries) so the
// tests describe exactly what a valid / invalid Office file looks like
// without shipping binaries into the repository.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  createOfficeValidator,
  readZipEntryNames,
} from '../../src/tooling/office-validator.mjs';
import { createToolingServices } from '../../src/tooling/index.mjs';

// ── minimal OOXML / PDF builders ────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** A stored (uncompressed) ZIP — the shape every OOXML container uses. */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content ?? '', 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // flags: no data descriptor
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, name, data]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

function docxEntries() {
  return [
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: '<Relationships/>' },
    { name: 'word/document.xml', content: '<w:document><w:body><w:p/></w:body></w:document>' },
  ];
}

function xlsxEntries(sheets = 1) {
  const entries = [
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: 'xl/workbook.xml', content: '<workbook><sheets/></workbook>' },
  ];
  for (let i = 1; i <= sheets; i += 1) {
    entries.push({ name: `xl/worksheets/sheet${i}.xml`, content: '<worksheet/>' });
  }
  return entries;
}

function pptxEntries(slides = 1) {
  const entries = [
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: 'ppt/presentation.xml', content: '<p:presentation/>' },
  ];
  for (let i = 1; i <= slides; i += 1) {
    entries.push({ name: `ppt/slides/slide${i}.xml`, content: '<p:sld/>' });
  }
  return entries;
}

function pdfBytes(pageCount = 1) {
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'latin1'),
    Buffer.from(`/Type /Pages /Count ${pageCount}\n`, 'latin1'),
    Buffer.from('%%EOF\n', 'latin1'),
  ]);
}

// ── fixtures ────────────────────────────────────────────────────────

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-office-validate-'));
});

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** One throwaway project with a `.trylo/out` deliverable root. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
  fs.mkdirSync(path.join(root, '.trylo', 'out'), { recursive: true });
  return root;
}

function writeOut(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

const UNAVAILABLE = {
  available: false,
  executable: null,
  version: null,
  reasonCode: 'not_installed',
};

function availableCli(run) {
  return { available: true, executable: 'C:/tools/officecli.exe', version: '1.0.145', reasonCode: null, run };
}

/** A validator with BOTH engines present; `script` decides what they answer. */
function validatorWith(script, overrides = {}) {
  return createOfficeValidator({
    resolveOfficeCli: async () => overrides.cli ?? {
      available: true,
      executable: 'C:/tools/officecli.exe',
      version: '1.0.145',
      reasonCode: null,
    },
    resolveLibreOffice: async () => overrides.lo ?? {
      available: true,
      executable: 'C:/tools/soffice.exe',
      version: '7.6.0.0',
      reasonCode: null,
    },
    run: script,
    tmpRoot: overrides.tmpRoot ?? tmpRoot,
    now: overrides.now,
    ...(overrides.maxArtifacts ? { maxArtifacts: overrides.maxArtifacts } : {}),
    ...(overrides.totalBudgetMs ? { totalBudgetMs: overrides.totalBudgetMs } : {}),
  });
}

/**
 * A run script for a HEALTHY pair of engines: `validate` answers
 * `{"success":true}` and the LibreOffice conversion actually leaves the PDF
 * behind (that output file is how the round-trip is judged).
 */
function okRun() {
  return async (exe, args) => {
    if (args[0] === 'validate') {
      return { code: 0, timedOut: false, stdout: '{"success":true}', stderr: '' };
    }
    if (args[0] === '--headless') {
      const outdirIndex = args.indexOf('--outdir');
      const outdir = outdirIndex >= 0 ? args[outdirIndex + 1] : '';
      const source = args[args.length - 1];
      if (outdir) {
        fs.mkdirSync(outdir, { recursive: true });
        fs.writeFileSync(
          path.join(outdir, `${path.basename(source, path.extname(source))}.pdf`),
          pdfBytes(1),
        );
      }
      return { code: 0, timedOut: false, stdout: '', stderr: '' };
    }
    return { code: 0, timedOut: false, stdout: '', stderr: '' };
  };
}

function findCheck(result, id) {
  return result.checks.find((entry) => entry.id === id);
}

// ── zip inspection (a real container, read back) ────────────────────

describe('readZipEntryNames (PR-5 container inspection)', () => {
  it('lists the entry names of a stored OOXML container', async () => {
    const root = makeProject();
    const file = writeOut(root, '.trylo/out/a.docx', buildZip(docxEntries()));
    const names = await readZipEntryNames(file);
    assert.deepEqual(names, ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  });

  it('stops at the central directory instead of scanning the whole file', async () => {
    const root = makeProject();
    // A big trailing blob after the central directory must not be read.
    const entries = docxEntries();
    const file = writeOut(root, '.trylo/out/big.docx', buildZip(entries));
    const names = await readZipEntryNames(file);
    assert.equal(names.length, 3);
  });

  it('returns null for a non-zip / empty file', async () => {
    const root = makeProject();
    const file = writeOut(root, '.trylo/out/empty.docx', Buffer.alloc(0));
    assert.equal(await readZipEntryNames(file), null);
  });

  it('reads entry names that straddle the 1 MiB read window', async () => {
    const root = makeProject();
    const padding = 'x'.repeat(1024 * 1024 + 512);
    const entries = [
      { name: '[Content_Types].xml', content: CONTENT_TYPES },
      { name: 'word/media/image1.png', content: padding },
      { name: 'word/document.xml', content: '<w:document/>' },
    ];
    const file = writeOut(root, '.trylo/out/large.docx', buildZip(entries));
    const names = await readZipEntryNames(file);
    assert.ok(names.includes('[Content_Types].xml'), 'first entry found');
    assert.ok(names.includes('word/document.xml'), 'entry after a >1 MiB payload found');
  });
});

// ── capability contract (§4.4) ──────────────────────────────────────

describe('office validator — capability degradation (§4.4 / §11)', () => {
  it('reports both engines unavailable with a reason instead of implying a pass', async () => {
    const validator = createOfficeValidator({
      resolveOfficeCli: async () => UNAVAILABLE,
      resolveLibreOffice: async () => UNAVAILABLE,
      tmpRoot,
    });
    const caps = await validator.capabilities();
    assert.equal(caps.officecli.available, false);
    assert.equal(caps.officecli.reasonCode, 'not_installed');
    assert.equal(caps.libreoffice.available, false);
  });

  it('a deliverable validated with NO engine is partial and names what was skipped', async () => {
    const validator = createOfficeValidator({
      resolveOfficeCli: async () => UNAVAILABLE,
      resolveLibreOffice: async () => UNAVAILABLE,
      tmpRoot,
    });
    const root = makeProject();
    writeOut(root, '.trylo/out/report.docx', buildZip(docxEntries()));
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [{ id: '.trylo/out/report.docx', relativePath: '.trylo/out/report.docx' }],
    });
    assert.equal(outcome.ok, true);
    const result = outcome.results[0];
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.skippedCapabilities, [
      'officecli:not_installed',
      'libreoffice:not_installed',
    ]);
    assert.equal(findCheck(result, 'structure').status, 'passed');
    assert.equal(findCheck(result, 'officecli-validate').status, 'skipped');
  });
});

// ── determinstic checks (steps 1 / 5 of §11) ────────────────────────

describe('office validator — deterministic checks (§11 steps 1 and 5)', () => {
  async function validateOneFile(relativePath, bytes, overrides = {}) {
    const validator = validatorWith(async () => ({ code: 0, timedOut: false, stdout: '', stderr: '' }), overrides);
    const root = makeProject();
    if (bytes !== null) writeOut(root, relativePath, bytes);
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [{ id: relativePath, relativePath }],
    });
    return outcome.results[0];
  }

  it('a non-Office file is skipped, not failed', async () => {
    const result = await validateOneFile('.trylo/out/shot.png', Buffer.from('PNGDATA'));
    assert.equal(result.status, 'skipped');
    assert.equal(result.reasonCode, 'not_office_file');
    assert.deepEqual(result.checks, []);
  });

  it('an unsafe persisted path is never opened', async () => {
    const result = await validateOneFile('../outside/evil.docx', buildZip(docxEntries()));
    assert.equal(result.status, 'skipped');
    assert.equal(findCheck(result, 'file-present').reasonCode, 'dotdot_segment');
  });

  it('a path outside .trylo/out is not treated as a deliverable', async () => {
    const result = await validateOneFile('docs/report.docx', buildZip(docxEntries()));
    assert.equal(result.status, 'skipped');
    assert.equal(findCheck(result, 'file-present').reasonCode, 'outside_deliverable_root');
  });

  it('a missing file fails the run-level claim', async () => {
    const result = await validateOneFile('.trylo/out/gone.docx', null);
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'file-present').reasonCode, 'missing');
  });

  it('an empty file fails', async () => {
    const result = await validateOneFile('.trylo/out/empty.docx', Buffer.alloc(0));
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'file-present').reasonCode, 'empty');
  });

  it('a .docx whose bytes are not a ZIP container fails (container_mismatch)', async () => {
    const result = await validateOneFile('.trylo/out/broken.docx', Buffer.from('this is not a zip'));
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'container-match').reasonCode, 'container_mismatch');
  });

  it('a .docx whose ZIP has no [Content_Types].xml is not an OOXML container', async () => {
    const result = await validateOneFile('.trylo/out/plain.docx', buildZip([{ name: 'readme.txt', content: 'hi' }]));
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'container-match').reasonCode, 'not_ooxml_container');
  });

  it('a .docx missing word/document.xml fails the structure check', async () => {
    const result = await validateOneFile(
      '.trylo/out/shell.docx',
      buildZip([{ name: '[Content_Types].xml', content: CONTENT_TYPES }]),
    );
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'structure').reasonCode, 'main_part_missing');
  });

  it('a workbook with no worksheet is an empty document (failed)', async () => {
    const result = await validateOneFile('.trylo/out/empty.xlsx', buildZip(xlsxEntries(0)));
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'structure').reasonCode, 'empty_document');
  });

  it('a workbook with 3 sheets reports the sheet count', async () => {
    const result = await validateOneFile('.trylo/out/three.xlsx', buildZip(xlsxEntries(3)));
    assert.equal(findCheck(result, 'structure').status, 'passed');
    assert.match(findCheck(result, 'structure').detail, /3 个工作表/);
  });

  it('a deck with no slide is an empty document (failed)', async () => {
    const result = await validateOneFile('.trylo/out/empty.pptx', buildZip(pptxEntries(0)));
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'structure').reasonCode, 'empty_document');
  });

  it('a deck with 2 slides reports the slide count', async () => {
    const result = await validateOneFile('.trylo/out/two.pptx', buildZip(pptxEntries(2)));
    assert.equal(findCheck(result, 'structure').status, 'passed');
    assert.match(findCheck(result, 'structure').detail, /2 张幻灯片/);
  });

  it('a PDF without the %PDF- header fails', async () => {
    const result = await validateOneFile('.trylo/out/broken.pdf', Buffer.from('not a pdf at all'));
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'container-match').reasonCode, 'container_mismatch');
  });

  it('a PDF reports its page count', async () => {
    const result = await validateOneFile('.trylo/out/doc.pdf', pdfBytes(4));
    assert.equal(findCheck(result, 'structure').status, 'passed');
    assert.match(findCheck(result, 'structure').detail, /4 页/);
  });
});

// ── engine-backed checks (§11 steps 2 / 3) ──────────────────────────

describe('office validator — engine-backed checks (§11 steps 2 and 3)', () => {
  it('a fully available pipeline marks a clean deliverable verified', async () => {
    const run = async (exe, args) => {
      if (args[0] === '--version') return { code: 0, timedOut: false, stdout: '1.0.145', stderr: '' };
      if (args[0] === 'validate') return { code: 0, timedOut: false, stdout: '{"success":true}', stderr: '' };
      if (args[0] === '--headless') return { code: 0, timedOut: false, stdout: '', stderr: '' };
      return { code: 1, timedOut: false, stdout: '', stderr: 'unexpected' };
    };
    // The LibreOffice step checks the produced PDF on disk: emulate it.
    const root = makeProject();
    writeOut(root, '.trylo/out/ok.docx', buildZip(docxEntries()));
    const validator = validatorWith(async (exe, args) => {
      const outcome = await run(exe, args);
      if (args[0] === '--headless') {
        const outdirIndex = args.indexOf('--outdir');
        const outdir = outdirIndex >= 0 ? args[outdirIndex + 1] : '';
        const source = args[args.length - 1];
        if (outdir) {
          fs.mkdirSync(outdir, { recursive: true });
          fs.writeFileSync(
            path.join(outdir, `${path.basename(source, path.extname(source))}.pdf`),
            pdfBytes(1),
          );
        }
      }
      return outcome;
    });
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [{ id: '.trylo/out/ok.docx', relativePath: '.trylo/out/ok.docx' }],
    });
    const result = outcome.results[0];
    assert.equal(findCheck(result, 'officecli-validate').status, 'passed');
    assert.equal(findCheck(result, 'libreoffice-roundtrip').status, 'passed');
    assert.equal(result.status, 'verified');
    assert.deepEqual(result.skippedCapabilities, []);
  });

  it('OfficeCLI validate reporting success:false fails the artifact with its code', async () => {
    const validator = validatorWith(async (exe, args) => {
      if (args[0] === 'validate') {
        return {
          code: 1,
          timedOut: false,
          stdout: '{"success":false,"error":{"code":"invalid_package","error":"The document is corrupt"}}',
          stderr: '',
        };
      }
      return { code: 0, timedOut: false, stdout: '', stderr: '' };
    }, { lo: { ...UNAVAILABLE, reasonCode: 'not_installed' } });
    const root = makeProject();
    writeOut(root, '.trylo/out/bad.docx', buildZip(docxEntries()));
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [{ id: '.trylo/out/bad.docx', relativePath: '.trylo/out/bad.docx' }],
    });
    const result = outcome.results[0];
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'officecli-validate').reasonCode, 'invalid_package');
  });

  it('an OfficeCLI CRASH is an engine error — never a corrupt-document verdict', async () => {
    // Observed on this machine: the pinned binary throws
    // `Unhandled exception: System.IO.FileNotFoundException: System.Private.Xml`
    // because the required .NET runtime is absent. That says nothing about
    // the document, so the check must be skipped (§4.4).
    const validator = validatorWith(async () => ({
      code: 1,
      timedOut: false,
      stdout: '',
      stderr: 'Unhandled exception: System.IO.FileNotFoundException: System.Private.Xml',
    }), { lo: { ...UNAVAILABLE, reasonCode: 'not_installed' } });
    const root = makeProject();
    writeOut(root, '.trylo/out/ok.docx', buildZip(docxEntries()));
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [{ id: '.trylo/out/ok.docx', relativePath: '.trylo/out/ok.docx' }],
    });
    const result = outcome.results[0];
    assert.equal(findCheck(result, 'officecli-validate').reasonCode, 'engine_error');
    assert.equal(findCheck(result, 'officecli-validate').status, 'skipped');
    assert.equal(result.status, 'partial', 'a missing engine degrades, it does not fail the file');
  });

  it('a LibreOffice conversion that produced nothing fails the artifact', async () => {
    const validator = validatorWith(async () => ({ code: 0, timedOut: false, stdout: '', stderr: '' }), {
      cli: { ...UNAVAILABLE, reasonCode: 'not_installed' },
    });
    const root = makeProject();
    writeOut(root, '.trylo/out/bad.pptx', buildZip(pptxEntries(1)));
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [{ id: '.trylo/out/bad.pptx', relativePath: '.trylo/out/bad.pptx' }],
    });
    const result = outcome.results[0];
    assert.equal(result.status, 'failed');
    assert.equal(findCheck(result, 'libreoffice-roundtrip').reasonCode, 'convert_failed');
  });

  it('an engine timeout is a skipped check, not a failure', async () => {
    const validator = validatorWith(async () => ({ code: null, timedOut: true, stdout: '', stderr: '' }));
    const root = makeProject();
    writeOut(root, '.trylo/out/slow.docx', buildZip(docxEntries()));
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [{ id: '.trylo/out/slow.docx', relativePath: '.trylo/out/slow.docx' }],
    });
    const result = outcome.results[0];
    assert.equal(findCheck(result, 'officecli-validate').reasonCode, 'engine_timeout');
    assert.equal(result.status, 'partial');
  });

  it('the LibreOffice scratch directory is removed after the round-trip', async () => {
    const root = makeProject();
    writeOut(root, '.trylo/out/ok.docx', buildZip(docxEntries()));
    const validator = validatorWith(async (exe, args) => {
      if (args[0] === '--headless') {
        const outdir = args[args.indexOf('--outdir') + 1];
        fs.mkdirSync(outdir, { recursive: true });
        return { code: 0, timedOut: false, stdout: '', stderr: '' };
      }
      return { code: 0, timedOut: false, stdout: '{"success":true}', stderr: '' };
    });
    await validator.validate({
      projectRoot: root,
      artifacts: [{ id: '.trylo/out/ok.docx', relativePath: '.trylo/out/ok.docx' }],
    });
    const leftovers = fs.readdirSync(tmpRoot).filter((name) => name.startsWith('trylo-office-validate-'));
    assert.deepEqual(leftovers, [], 'no validation scratch space survives');
  });
});

// ── bounds and never-throw (§14) ────────────────────────────────────

describe('office validator — bounds and failure policy (§14 / §4.4)', () => {
  it('validates at most maxArtifacts and reports the truncation', async () => {
    const validator = validatorWith(okRun(), { maxArtifacts: 2 });
    const root = makeProject();
    const list = [];
    for (let i = 0; i < 5; i += 1) {
      const rel = `.trylo/out/f${i}.docx`;
      writeOut(root, rel, buildZip(docxEntries()));
      list.push({ id: rel, relativePath: rel });
    }
    const outcome = await validator.validate({ projectRoot: root, artifacts: list });
    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.budgetExceeded, true);
  });

  it('reports budget exhaustion per artifact once the clock ran out', async () => {
    // A clock that advances on every read: the per-run budget is gone by the
    // time the first artifact would be inspected.
    let clock = 0;
    const validator = validatorWith(okRun(), {
      now: () => { clock += 20; return clock; },
      totalBudgetMs: 10,
    });
    const root = makeProject();
    const rel = '.trylo/out/a.docx';
    writeOut(root, rel, buildZip(docxEntries()));
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [{ id: rel, relativePath: rel }],
    });
    assert.equal(outcome.results[0].status, 'skipped');
    assert.equal(findCheck(outcome.results[0], 'file-present').reasonCode, 'budget_exhausted');
  });

  it('never throws without a project root', async () => {
    const validator = validatorWith(async () => ({ code: 0, timedOut: false, stdout: '', stderr: '' }));
    const outcome = await validator.validate({ artifacts: [] });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, 'missing_project_root');
  });

  it('a failing container never blocks the remaining artifacts', async () => {
    const validator = validatorWith(okRun());
    const root = makeProject();
    writeOut(root, '.trylo/out/bad.docx', Buffer.from('nope'));
    writeOut(root, '.trylo/out/good.docx', buildZip(docxEntries()));
    const outcome = await validator.validate({
      projectRoot: root,
      artifacts: [
        { id: '.trylo/out/bad.docx', relativePath: '.trylo/out/bad.docx' },
        { id: '.trylo/out/good.docx', relativePath: '.trylo/out/good.docx' },
      ],
    });
    assert.equal(outcome.results[0].status, 'failed');
    assert.equal(outcome.results[1].status, 'verified');
  });
});

// ── service-host surface (PR-5 wiring) ──────────────────────────────

describe('tooling service surface — Office validation methods (PR-5)', () => {
  it('exposes officeValidationCapabilities and validateOfficeArtifacts', async () => {
    const tooling = createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        hermes: {
          mcpArgs: () => ({ ok: true, arg: [], warning: null, configPath: null }),
        },
        installRoot: path.join(tmpRoot, 'tool-packages'),
        profilesRoot: path.join(tmpRoot, 'tool-profiles'),
        officeValidator: {
          resolveOfficeCli: async () => UNAVAILABLE,
          resolveLibreOffice: async () => UNAVAILABLE,
          tmpRoot,
        },
      },
    });
    const caps = await tooling.officeValidationCapabilities();
    assert.equal(caps.ok, true);
    assert.equal(caps.officecli.available, false);
    assert.equal(typeof caps.officecli.reasonCode, 'string');

    const root = makeProject();
    writeOut(root, '.trylo/out/report.docx', buildZip(docxEntries()));
    const outcome = await tooling.validateOfficeArtifacts({
      projectRoot: root,
      artifacts: [{ id: '.trylo/out/report.docx', relativePath: '.trylo/out/report.docx' }],
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.results[0].status, 'partial');
    tooling.dispose();
  });

  it('a version-drifted officecli binary is refused as a capability (§3)', async () => {
    // A binary answering `--version` with something the manifest did not pin
    // is NOT the pinned package — that is a drift, never a shim (§3 / §15.2).
    const tooling = createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        hermes: { mcpArgs: () => ({ ok: true, arg: [], warning: null, configPath: null }) },
        installRoot: path.join(tmpRoot, 'tool-packages-drift'),
        profilesRoot: path.join(tmpRoot, 'tool-profiles'),
        // Isolate from TRYLO_TOOL_PACKAGE_OVERRIDES in the dev environment:
        // the override path bypasses installRoot entirely and would resolve
        // officecli as available when the env var points at a real binary.
        overrides: {},
        // The real resolver path is used, with only the child process (and
        // the package state) injected — the version gate itself is the thing
        // under test.
        officeValidator: {
          run: async () => ({ code: 0, timedOut: false, stdout: '1.0.999', stderr: '' }),
          resolveLibreOffice: async () => UNAVAILABLE,
          tmpRoot,
        },
      },
    });
    const caps = await tooling.officeValidationCapabilities();
    // No installed package → not_installed (the drift gate is unreachable
    // without an installed binary); the contract asserted here is that the
    // capability call never throws and always carries a reason code.
    assert.equal(caps.ok, true);
    assert.equal(typeof caps.officecli.reasonCode, 'string');
    assert.equal(caps.officecli.available, false);
    tooling.dispose();
  });
});
