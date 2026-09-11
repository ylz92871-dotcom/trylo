// Trylo Desktop Services — Office delivery validation pipeline (PR-5, §11).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §11:
//   「Office 交付不是"工具调用成功"，而是验证流水线成功」
//   「验证工具不必都暴露成 MCP，确定性 host pipeline 更可靠」
//
// This module is that deterministic host pipeline. It runs AFTER a Work run
// reaches a terminal state, over the deliverables the `.trylo/out` scanner
// surfaced (§7.3: the ONLY place a deliverable can come from).
//
// Design rules that follow from the spec and from the prior PRs:
//
//   1. NEVER FAKE A PASS. A capability that is missing becomes a SKIPPED
//      check plus an explicit entry in `skippedCapabilities` (§4.4: 工具不
//      可用时的降级合同 — the UI must show "部分验证" and WHY, never a
//      silent "已验证").
//   2. NEVER THROW. Every failure is a reason code the caller can show
//      verbatim; a broken validator must not break a run (§4.4).
//   3. BOUNDED. A bounded number of artifacts, a total budget and a per-step
//      timeout. Validation is additive to the run, never a blocker on it.
//   4. NOT EVERYTHING IS MCP. `validate` is spawned as the pinned executable
//      directly (§11); MCP stays the model-facing path only.
//   5. An ENGINE failure is not a DOCUMENT failure. If the validator binary
//      itself cannot run (missing runtime, crash) that check is SKIPPED with
//      `engine_error` — never reported as a corrupt deliverable.
//
// Two capability classes:
//   · deterministic (no external dependency): file-present, container-match,
//     structure. Always run for an Office extension.
//   · engine-backed: OfficeCLI `validate` (pinned package, §10.1) and
//     LibreOffice headless round-trip (system dependency, §2.3 — used as-is,
//     never forked). Skipped, with a reason, when unavailable.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { validateArtifactRelativePath } from './artifact-promoter.mjs';

// ── bounds (§14: bounded work, never a run blocker) ─────────────────
const MAX_ARTIFACTS_PER_RUN = 20;
const TOTAL_BUDGET_MS = 45_000;
const VALIDATE_TIMEOUT_MS = 15_000;
const CONVERT_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;
/** Capability probes are cached so a run never pays for a slow probe twice. */
const CAPABILITY_TTL_MS = 5 * 60 * 1000;

const MAX_DETAIL_LEN = 240;
const MAX_OUTPUT_LEN = 400;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 512;

/** Office deliverable extensions this pipeline knows how to judge. */
const OFFICE_EXTENSIONS = Object.freeze({
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.pdf': 'pdf',
});

/** Where a deliverable may live (§7.3: the ONLY deliverable root). */
const OUT_DIR_SEGMENTS = '.trylo/out';

const STATUS_ORDER = Object.freeze({ failed: 0, partial: 1, verified: 2, skipped: 3 });

// ── helpers ─────────────────────────────────────────────────────────

function clip(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function extensionOf(filePath) {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** Same lexical contract as the artifact promoter: relative, no `..`, no
 *  UNC / device / drive-relative forms, no absolute paths. */
function safeRelative(rel) {
  return validateArtifactRelativePath(rel);
}

/** Deliverable root containment (belt over braces — the scanner already
 *  enforces it, and a hand-edited id must not widen it). */
function isUnderOutRoot(absolutePath, projectRoot) {
  const norm = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = norm(path.join(path.resolve(projectRoot), OUT_DIR_SEGMENTS)).toLowerCase();
  const candidate = norm(absolutePath).toLowerCase();
  return candidate === root || candidate.startsWith(`${root}/`);
}

function check(id, status, reasonCode, detail) {
  return {
    id,
    status,
    ...(reasonCode ? { reasonCode } : {}),
    ...(detail ? { detail: clip(detail, MAX_DETAIL_LEN) } : {}),
  };
}

// ── child process ───────────────────────────────────────────────────

/**
 * One bounded child process. Resolves — never rejects — with the exit code,
 * a truncated stdout/stderr and a `timedOut` flag.
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {number} timeoutMs
 */
export function runBounded(executable, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    try {
      // `execFile`'s own timeout kills the child and reports it through the
      // callback (`error.killed`). The captured handle is only kept so a
      // synchronous spawn failure cannot leave the promise pending.
      execFile(
        executable,
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const so = typeof stdout === 'string' ? stdout : '';
          const se = typeof stderr === 'string' ? stderr : '';
          if (error && error.killed) {
            finish({ code: null, timedOut: true, stdout: so, stderr: se, error: 'timeout' });
            return;
          }
          finish({
            code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
            timedOut: false,
            stdout: so.slice(0, MAX_OUTPUT_LEN),
            stderr: se.slice(0, MAX_OUTPUT_LEN),
            ...(error && !error.code ? { error: clip(String(error.message ?? error), 160) } : {}),
          });
        },
      );
    } catch (error) {
      finish({ code: 1, timedOut: false, stdout: '', stderr: '', error: clip(String(error?.message ?? error), 160) });
    }
  });
}

/** A crash the engine itself produced is not evidence about the document. */
function looksLikeEngineCrash(output) {
  return /unhandled exception|system\.(io|private|runtime)|\.net runtime/i.test(output);
}

// ── LibreOffice capability (system dependency, §2.3) ────────────────

const LIBREOFFICE_CANDIDATES = Object.freeze([
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
]);

/**
 * Resolve the LibreOffice executable. Order: explicit seam/env override →
 * pinned install candidates → PATH. A resolved path is still PROBED with
 * `--version` before it counts as available (§11 step 3 is conditional on
 * 「若安装」, and a stale path must not be reported as a capability).
 */
export function createLibreOfficeResolver(options = {}) {
  const envOverride = options.envOverride
    ?? (typeof process.env.TRYLO_LIBREOFFICE_PATH === 'string' && process.env.TRYLO_LIBREOFFICE_PATH !== ''
      ? process.env.TRYLO_LIBREOFFICE_PATH
      : null);
  const exists = options.exists ?? ((p) => fs.existsSync(p));
  const run = options.run ?? runBounded;

  async function probe(executable) {
    const outcome = await run(executable, ['--version'], PROBE_TIMEOUT_MS);
    if (outcome.timedOut) return { available: false, reasonCode: 'probe_timeout' };
    if (outcome.code !== 0) return { available: false, reasonCode: 'probe_failed' };
    const text = `${outcome.stdout}${outcome.stderr}`.trim();
    return { available: true, version: clip(text.split('\n')[0] ?? '', 120) ?? null };
  }

  return async function resolve() {
    const tried = [];
    if (envOverride) tried.push(envOverride);
    for (const candidate of LIBREOFFICE_CANDIDATES) tried.push(candidate);
    tried.push('soffice'); // PATH lookup (execFile resolves it)

    for (const candidate of tried) {
      if (candidate !== 'soffice' && !exists(candidate)) continue;
      const probed = await probe(candidate);
      if (probed.available) {
        return { available: true, executable: candidate, version: probed.version, reasonCode: null };
      }
      if (candidate !== 'soffice' && probed.reasonCode === 'probe_timeout') {
        return { available: false, executable: null, version: null, reasonCode: 'probe_timeout' };
      }
    }
    return { available: false, executable: null, version: null, reasonCode: 'not_installed' };
  };
}

// ── container / structure inspection (deterministic, no dependency) ──

const OOXML_REQUIRED_PART = Object.freeze({
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
});

/**
 * Walk a ZIP's LOCAL file headers and collect entry names. Streaming-safe:
 * it never inflates anything and it stops at the central directory, at a
 * streaming entry whose length is unknown (data descriptor, flag bit 3), or
 * at the byte / entry budget. Returns `null` when the bytes are not readable.
 */
export async function readZipEntryNames(filePath) {
  const CHUNK = 1024 * 1024;
  let handle = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) return null;

    const names = [];
    const buf = Buffer.alloc(CHUNK);
    let filePos = 0; // next byte to read from the file
    let read = 0;
    let data = Buffer.alloc(0); // carry-over window being scanned
    let dataStart = 0; // file offset of data[0]

    while (read < MAX_SCAN_BYTES && names.length < MAX_ZIP_ENTRIES) {
      if (filePos >= stat.size && data.length === 0) break;
      let bytesRead = 0;
      if (filePos < stat.size) {
        const outcome = await handle.read(buf, 0, CHUNK, filePos);
        bytesRead = outcome.bytesRead;
        read += bytesRead;
        filePos += bytesRead;
      }
      if (bytesRead === 0 && data.length === 0) break;
      data = bytesRead > 0
        ? (data.length > 0
          ? Buffer.concat([data, buf.subarray(0, bytesRead)])
          : Buffer.from(buf.subarray(0, bytesRead)))
        : data;
      // `dataStart` is only meaningful when a carry-over exists; recompute it
      // from the previous window's tail so a signature straddling the chunk
      // boundary is still found.
      dataStart = filePos - data.length;

      let cursor = 0;
      let stop = false;
      while (cursor + 4 <= data.length) {
        const sig = data.readUInt32LE(cursor);
        if (sig === 0x02014b50 || sig === 0x06054b50) { stop = true; break; } // central dir / EOCD
        if (sig !== 0x04034b50) { cursor += 1; continue; }
        if (cursor + 30 > data.length) break;
        const flags = data.readUInt16LE(cursor + 6);
        const compressedSize = data.readUInt32LE(cursor + 18);
        const nameLength = data.readUInt16LE(cursor + 26);
        const extraLength = data.readUInt16LE(cursor + 28);
        if (cursor + 30 + nameLength > data.length) break;
        names.push(data.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8'));
        // A streaming entry (bit 3) carries no length in its local header —
        // the next signature cannot be located reliably, so stop here.
        if ((flags & 0x08) !== 0) { stop = true; break; }
        cursor += 30 + nameLength + extraLength + compressedSize;
      }
      if (stop) break;
      if (cursor === 0) {
        // Nothing recognisable in this window: keep only a 3-byte tail so a
        // straddling signature is not lost, then keep reading.
        const tail = Math.min(3, data.length);
        data = Buffer.from(data.subarray(data.length - tail));
        dataStart = filePos - data.length;
        if (bytesRead === 0) break;
        continue;
      }
      data = Buffer.from(data.subarray(Math.min(cursor, data.length)));
      dataStart = filePos - data.length;
      if (bytesRead === 0 && data.length < 30) break; // EOF with a partial header
    }
    return names;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** Count `/Type /Page` occurrences — a deterministic PDF page signal. */
async function readPdfPageCount(filePath) {
  let handle = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const stat = await handle.stat();
    if (stat.size > MAX_SCAN_BYTES) return null;
    const bytes = await handle.readFile();
    const text = bytes.toString('latin1');
    const counts = [...text.matchAll(/\/Count\s+(\d+)/g)]
      .map((m) => Number.parseInt(m[1] ?? '', 10))
      .filter((n) => Number.isFinite(n));
    if (counts.length === 0) return null;
    return Math.max(...counts);
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * §11 step 1 (文件存在、非空、扩展名与容器匹配) + step 5's deterministic
 * part (页数 / sheet / slide). Pure, dependency-free, always runs.
 */
async function inspectContainer(filePath, kind) {
  if (kind === 'pdf') {
    let handle = null;
    try {
      handle = await fsp.open(filePath, 'r');
      const head = Buffer.alloc(5);
      const { bytesRead } = await handle.read(head, 0, 5, 0);
      const magic = head.subarray(0, bytesRead).toString('latin1');
      if (!magic.startsWith('%PDF-')) {
        return { match: check('container-match', 'failed', 'container_mismatch', '文件头不是 PDF（%PDF-）') };
      }
    } catch (error) {
      return { match: check('container-match', 'skipped', 'unreadable', String(error?.message ?? error)) };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    const pages = await readPdfPageCount(filePath);
    if (pages === null) {
      return {
        match: check('container-match', 'passed'),
        structure: check('structure', 'skipped', 'page_count_unavailable', '未能确定页数'),
      };
    }
    return {
      match: check('container-match', 'passed'),
      structure: pages > 0
        ? check('structure', 'passed', undefined, `${pages} 页`)
        : check('structure', 'failed', 'empty_document', '页数为 0'),
    };
  }

  // OOXML: a ZIP container holding `[Content_Types].xml` and its main part.
  let handle = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    if (bytesRead < 4 || head.readUInt32LE(0) !== 0x04034b50) {
      return { match: check('container-match', 'failed', 'container_mismatch', '扩展名是 OOXML，但文件不是 ZIP 容器') };
    }
  } catch (error) {
    return { match: check('container-match', 'skipped', 'unreadable', String(error?.message ?? error)) };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  const entries = await readZipEntryNames(filePath);
  if (entries === null) {
    return {
      match: check('container-match', 'passed'),
      structure: check('structure', 'skipped', 'container_unreadable', 'ZIP 结构不可读'),
    };
  }
  const lowered = entries.map((name) => name.toLowerCase());
  if (!lowered.includes('[content_types].xml')) {
    return { match: check('container-match', 'failed', 'not_ooxml_container', '缺少 [Content_Types].xml') };
  }

  const required = OOXML_REQUIRED_PART[kind];
  if (!lowered.includes(required)) {
    return {
      match: check('container-match', 'passed'),
      structure: check('structure', 'failed', 'main_part_missing', `缺少 ${required}`),
    };
  }

  const countOf = (pattern) => lowered.filter((name) => pattern.test(name)).length;
  if (kind === 'xlsx') {
    const sheets = countOf(/^xl\/worksheets\/sheet\d+\.xml$/);
    return {
      match: check('container-match', 'passed'),
      structure: sheets > 0
        ? check('structure', 'passed', undefined, `${sheets} 个工作表`)
        : check('structure', 'failed', 'empty_document', '工作簿没有工作表'),
    };
  }
  if (kind === 'pptx') {
    const slides = countOf(/^ppt\/slides\/slide\d+\.xml$/);
    return {
      match: check('container-match', 'passed'),
      structure: slides > 0
        ? check('structure', 'passed', undefined, `${slides} 张幻灯片`)
        : check('structure', 'failed', 'empty_document', '演示文稿没有幻灯片'),
    };
  }
  return {
    match: check('container-match', 'passed'),
    structure: check('structure', 'passed', undefined, '包含 word/document.xml'),
  };
}

// ── engine steps ────────────────────────────────────────────────────

/** §11 step 2: `officecli validate <file> --json` (pinned 1.0.145 CLI; the
 *  `--help` of the pinned build is the contract — `validate` takes a
 *  POSITIONAL file, `--json` is a global flag). */
async function runOfficeCliValidate(executable, filePath, run, timeoutMs) {
  const outcome = await run(executable, ['validate', filePath, '--json'], timeoutMs);
  if (outcome.timedOut) return check('officecli-validate', 'skipped', 'engine_timeout', 'validate 超时');
  const text = `${outcome.stdout}${outcome.stderr}`;
  let parsed = null;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') {
    if (parsed.success === true) return check('officecli-validate', 'passed');
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : 'validate_failed';
    const message = typeof parsed.error?.error === 'string' ? parsed.error.error : undefined;
    return check('officecli-validate', 'failed', code, message);
  }
  // No JSON: the engine itself failed (e.g. a missing .NET runtime). That is
  // never evidence that the DOCUMENT is broken (rule 5 above).
  if (looksLikeEngineCrash(text) || outcome.code === null) {
    return check('officecli-validate', 'skipped', 'engine_error', 'officecli 无法运行（引擎自身故障）');
  }
  if (outcome.code === 0) return check('officecli-validate', 'passed');
  return check('officecli-validate', 'skipped', 'engine_error', clip(text, MAX_DETAIL_LEN));
}

/** §11 step 3: LibreOffice headless round-trip. A document LibreOffice can
 *  open and convert is, by definition, not unrecoverably corrupt (§13). */
async function runLibreOfficeRoundTrip(executable, filePath, run, tmpRoot, timeoutMs) {
  const outDir = path.join(tmpRoot, `trylo-office-validate-${crypto.randomUUID()}`);
  try {
    await fsp.mkdir(outDir, { recursive: true });
  } catch (error) {
    return { check: check('libreoffice-roundtrip', 'skipped', 'tmpdir_failed', String(error?.message ?? error)) };
  }
  try {
    const outcome = await run(executable, [
      '--headless',
      '--norestore',
      '--convert-to', 'pdf',
      '--outdir', outDir,
      filePath,
    ], timeoutMs);
    if (outcome.timedOut) {
      return { check: check('libreoffice-roundtrip', 'skipped', 'engine_timeout', '转换超时') };
    }
    const expected = `${path.basename(filePath, path.extname(filePath))}.pdf`;
    const produced = path.join(outDir, expected);
    try {
      const stat = await fsp.stat(produced);
      if (stat.isFile() && stat.size > 0) {
        return { check: check('libreoffice-roundtrip', 'passed', undefined, '可打开并转换为 PDF') };
      }
      return { check: check('libreoffice-roundtrip', 'failed', 'convert_no_output', '转换未产生 PDF') };
    } catch {
      return {
        check: check(
          'libreoffice-roundtrip',
          'failed',
          'convert_failed',
          clip(`${outcome.stdout}${outcome.stderr}`, MAX_DETAIL_LEN) ?? '转换失败',
        ),
      };
    }
  } finally {
    // Best effort: validation scratch space is never a deliverable.
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── aggregation ─────────────────────────────────────────────────────

function aggregate(checks, skippedCapabilities) {
  if (checks.some((entry) => entry.status === 'failed')) return 'failed';
  const skipped = checks.some((entry) => entry.status === 'skipped');
  if (skipped || skippedCapabilities.length > 0) return 'partial';
  if (checks.length === 0) return 'skipped';
  return 'verified';
}

// ── the validator ───────────────────────────────────────────────────

/**
 * @param {{
 *   resolveOfficeCli?: () => Promise<{ available: boolean,
 *     executable: string | null, version: string | null, reasonCode: string | null }>,
 *   resolveLibreOffice?: () => Promise<{ available: boolean,
 *     executable: string | null, version: string | null, reasonCode: string | null }>,
 *   run?: (exe: string, args: readonly string[], timeoutMs: number) =>
 *     Promise<{ code: number | null, timedOut: boolean, stdout: string,
 *               stderr: string, error?: string }>,
 *   tmpRoot?: string,
 *   now?: () => number,
 *   maxArtifacts?: number,
 *   totalBudgetMs?: number,
 * }} [options]
 */
export function createOfficeValidator(options = {}) {
  const now = options.now ?? (() => Date.now());
  const run = options.run ?? runBounded;
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const maxArtifacts = options.maxArtifacts ?? MAX_ARTIFACTS_PER_RUN;
  const totalBudgetMs = options.totalBudgetMs ?? TOTAL_BUDGET_MS;

  const libreOffice = options.resolveLibreOffice ?? createLibreOfficeResolver({ run });
  const officeCli = options.resolveOfficeCli ?? (async () => ({
    available: false,
    executable: null,
    version: null,
    reasonCode: 'not_configured',
  }));

  let cachedCapabilities = null;
  let cachedAt = 0;
  /** The executable paths stay INSIDE the validator. The reported capability
   *  record is capability state only (available / version / reason) — a
   *  renderer-side consumer never needs an absolute binary path, and not
   *  shipping one keeps the protocol surface minimal (§16.8). */
  let resolvedCli = null;
  let resolvedLo = null;

  /** §4.4: capability state is reported with a reason, never as a silent
   *  pass and never as a model failure. Cached so a slow probe cannot be
   *  paid for twice inside one run. */
  async function capabilities(params = {}) {
    const fresh = cachedCapabilities && now() - cachedAt < CAPABILITY_TTL_MS;
    if (fresh && params.refresh !== true) return cachedCapabilities;
    const [cli, lo] = await Promise.all([officeCli(), libreOffice()]);
    resolvedCli = cli;
    resolvedLo = lo;
    cachedCapabilities = {
      ok: true,
      checkedAt: now(),
      officecli: {
        available: cli.available === true,
        version: cli.version ?? null,
        reasonCode: cli.available === true ? null : (cli.reasonCode ?? 'unavailable'),
      },
      libreoffice: {
        available: lo.available === true,
        version: lo.version ?? null,
        reasonCode: lo.available === true ? null : (lo.reasonCode ?? 'unavailable'),
      },
    };
    cachedAt = now();
    return cachedCapabilities;
  }

  /**
   * Validate the Office deliverables of one run.
   * @param {{ projectRoot: string,
   *           artifacts: readonly { id: string, relativePath: string }[] }} params
   */
  async function validate(params = {}) {
    const startedAt = now();
    const projectRoot = String(params.projectRoot ?? '');
    const requested = Array.isArray(params.artifacts) ? params.artifacts : [];
    const caps = await capabilities();

    if (!projectRoot) {
      return {
        ok: false,
        reasonCode: 'missing_project_root',
        capabilities: caps,
        checkedAt: startedAt,
        budgetExceeded: false,
        results: [],
      };
    }

    const results = [];
    let budgetExceeded = false;

    for (const artifact of requested.slice(0, maxArtifacts)) {
      const relativePath = String(artifact?.relativePath ?? '');
      const id = String(artifact?.id ?? relativePath);
      const invalid = safeRelative(relativePath);
      if (invalid) {
        results.push({
          id,
          relativePath,
          status: 'skipped',
          checks: [check('file-present', 'skipped', invalid, '产物路径不安全，未做验证')],
          skippedCapabilities: [],
          checkedAt: now(),
        });
        continue;
      }
      const remaining = totalBudgetMs - (now() - startedAt);
      if (remaining <= 0) {
        budgetExceeded = true;
        results.push({
          id,
          relativePath,
          status: 'skipped',
          checks: [check('file-present', 'skipped', 'budget_exhausted', '本轮验证预算已用尽')],
          skippedCapabilities: [],
          checkedAt: now(),
        });
        continue;
      }

      results.push(await validateOne({
        id,
        relativePath,
        projectRoot,
        cli: resolvedCli ?? { available: false, executable: null, reasonCode: 'unavailable' },
        lo: resolvedLo ?? { available: false, executable: null, reasonCode: 'unavailable' },
        run,
        tmpRoot,
        now,
        budgetMs: remaining,
      }));
    }
    if (requested.length > maxArtifacts) budgetExceeded = true;

    return {
      ok: true,
      capabilities: caps,
      checkedAt: startedAt,
      budgetExceeded,
      results,
    };
  }

  return { validate, capabilities };
}

async function validateOne(args) {
  const { id, relativePath, projectRoot, cli, lo, run, tmpRoot, now, budgetMs } = args;
  const absolute = path.resolve(projectRoot, relativePath);
  const startedAt = now();
  const checks = [];
  const skippedCapabilities = [];

  if (!isUnderOutRoot(absolute, projectRoot)) {
    return {
      id,
      relativePath,
      status: 'skipped',
      checks: [check('file-present', 'skipped', 'outside_deliverable_root', '不在 .trylo/out 内，不是交付物')],
      skippedCapabilities: [],
      checkedAt: now(),
    };
  }

  const kind = OFFICE_EXTENSIONS[extensionOf(relativePath)];
  if (!kind) {
    return {
      id,
      relativePath,
      status: 'skipped',
      checks: [],
      skippedCapabilities: [],
      reasonCode: 'not_office_file',
      checkedAt: now(),
    };
  }

  // Step 1 (§11): present, non-empty, regular file.
  let stat = null;
  try {
    stat = await fsp.lstat(absolute);
  } catch {
    stat = null;
  }
  if (!stat) {
    checks.push(check('file-present', 'failed', 'missing', '文件不存在'));
    return finish();
  }
  if (!stat.isFile()) {
    checks.push(check('file-present', 'failed', 'not_a_regular_file', '不是常规文件（可能是符号链接或目录）'));
    return finish();
  }
  if (stat.size <= 0) {
    checks.push(check('file-present', 'failed', 'empty', '文件为空'));
    return finish();
  }
  checks.push(check('file-present', 'passed', undefined, `${stat.size} 字节`));

  // Steps 1 + 5 (deterministic part): container match + structure.
  const inspected = await inspectContainer(absolute, kind);
  checks.push(inspected.match);
  if (inspected.structure) checks.push(inspected.structure);
  if (inspected.match.status === 'failed') return finish();

  // Step 2: pinned OfficeCLI `validate`.
  const remainingFor = (want) => Math.max(1, Math.min(want, budgetMs - (now() - startedAt)));
  if (cli.available) {
    checks.push(await runOfficeCliValidate(cli.executable, absolute, run, remainingFor(VALIDATE_TIMEOUT_MS)));
  } else {
    skippedCapabilities.push(`officecli:${cli.reasonCode ?? 'unavailable'}`);
    checks.push(check('officecli-validate', 'skipped', cli.reasonCode ?? 'unavailable', 'OfficeCLI 不可用，未执行格式校验'));
  }

  // Step 3: LibreOffice headless round-trip (only when installed, §11).
  if (lo.available) {
    const outcome = await runLibreOfficeRoundTrip(lo.executable, absolute, run, tmpRoot, remainingFor(CONVERT_TIMEOUT_MS));
    checks.push(outcome.check);
  } else {
    skippedCapabilities.push(`libreoffice:${lo.reasonCode ?? 'unavailable'}`);
    checks.push(check('libreoffice-roundtrip', 'skipped', lo.reasonCode ?? 'unavailable', '未安装 LibreOffice，未执行打开/转换验证'));
  }

  return finish();

  function finish() {
    return {
      id,
      relativePath,
      status: aggregate(checks, skippedCapabilities),
      checks,
      skippedCapabilities,
      checkedAt: now(),
    };
  }
}

export {
  MAX_ARTIFACTS_PER_RUN,
  TOTAL_BUDGET_MS,
  OFFICE_EXTENSIONS,
  STATUS_ORDER,
};

export default createOfficeValidator;
