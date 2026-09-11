// Trylo Desktop — OfficeCLI risk classifier.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.4 (command table) /
// §6.3 (permission matrix) / §6.2 (path rules).
//
// REAL MCP CONTRACT (pinned officecli 1.0.145, `officecli mcp`, verified
// against OfficeCLI/src/officecli/McpServer.cs):
//   The server exposes exactly ONE tool (`officecli`) with ONE parameter:
//   `command` — a full officecli command line as a STRING
//   (e.g. "add deck.pptx /slide[1] --type shape --prop text=Hi") or a
//   pre-split argv ARRAY of strings. A leading "officecli" token is
//   optional. There are NO per-verb structured fields: the document path is
//   a POSITIONAL token (e.g. "view deck.pptx outline",
//   "create .trylo/out/deck.pptx"), element selectors look like
//   "/slide[1]" or "cell[bold=true]", outputs use "--out/-o", and batch
//   sub-operations ride in "--commands <inline JSON>" / "--input <json
//   file>" / stdin.
//
// The classifier therefore tokenises the command line exactly like the
// server's own quote-aware tokenizer, takes argv[0] as the verb, and pulls
// filesystem-path tokens out by verb-specific positional slots and known
// path options. Element selectors, modes, prop values and inline JSON are
// never mistaken for filesystem paths.
//
// Policy table (§6.4) — the PINNED command enum (exactly 13 verbs):
//   view/get/query/validate/help                 → read (paths must be in scope)
//   create/set/add/move/merge                    → workspace-write
//                                    · target under .trylo/out → may auto
//                                    · any other workspace path → modifies
//                                      the ORIGINAL → approval
//   remove                       → destructive   (always approval; read_only deny)
//   raw                          → sensitive     (always approval; read_only deny)
//   batch                        → recursive     (highest risk wins; parse
//                                                   failure NEVER auto-allows;
//                                                   a batch with no inspectable
//                                                   payload fails CLOSED (deny);
//                                                   a --input payload file
//                                                   cannot be inspected
//                                                   lexically and always
//                                                   requires human approval)
//   anything else (incl. vendor drift verbs)    → deny
//
// Path rules (§6.4 「禁止 ..、绝对路径逃逸、UNC/设备路径和 symlink 逃逸」):
//   control chars, UNC and device-namespace paths, drive-relative forms,
//   reserved DOS device names, `..` segments and any path resolving outside
//   the workspace root are DENIED at every permission level. This module is
//   lexical only — symlink/reparse escapes are re-validated by the Rust host
//   (fs::canonicalize) at execution, exactly like the approval-preview gate.

import type { ApprovalPreview } from '../../approval/approval-preview';
import { canonicalizeCwd } from '../runtime-fingerprint';
import type {
  PackageRiskClassifier,
  SafeAudit,
  ToolRiskContext,
  ToolRiskDecision,
} from '../tool-risk-classifier';
import { inputDigestOf } from '../input-digest';

/** Legacy/alternative structured path fields (「file/output/path 都要验证」).
 *  The real MCP contract is the command line; these fields, when present
 *  alongside `command`, are validated just the same. */
const PATH_FIELDS = ['file', 'output', 'path'] as const;
type PathField = (typeof PATH_FIELDS)[number];

/**
 * Top-level array fields carrying a batch's sub-operations (legacy
 * structured shape). The real CLI passes batch ops as inline JSON via
 * `--commands` or a file via `--input`; BOTH shapes are understood.
 */
const BATCH_ARRAY_FIELDS = ['batch', 'operations', 'commands'] as const;

// ── verb tables (the pinned officecli 1.0.145 command set) ──────────

/** Read-only verbs — the pinned §6.4 read set. */
const READ_COMMANDS = new Set(['view', 'get', 'query', 'validate', 'help']);

/** Verbs that create or modify a document — the pinned §6.4 write set. */
const WRITE_COMMANDS = new Set(['create', 'set', 'add', 'move', 'merge', 'layout']);

const REMOVE_COMMANDS = new Set(['remove']);
/** `raw` reads/writes raw XML (sensitive: the universal escape hatch);
 *  it always requires approval. */
const RAW_COMMANDS = new Set(['raw']);
const BATCH_COMMANDS = new Set(['batch']);

/** Control verbs inside an inline batch payload (e.g. {"command":"meta",
 *  "dumpVersion":2}). They mutate no document. */
const BATCH_META_COMMANDS = new Set(['meta']);

const ALL_COMMANDS = new Set<string>([
  ...READ_COMMANDS,
  ...WRITE_COMMANDS,
  ...REMOVE_COMMANDS,
  ...RAW_COMMANDS,
  ...BATCH_COMMANDS,
]);

/** Inputs above this canonical-JSON size are never auto-allowed (§14.2
 *  「超大 input」/§6.2 「解析失败不能自动放行」). */
const MAX_INPUT_JSON_LENGTH = 256 * 1024;

/** Deliverables directory — the ONLY write zone that may auto-allow. */
const OUT_DIR_SEGMENTS = '.trylo/out';

const OFFICECLI_SERVER_NAME = 'trylo-office';
const OFFICECLI_TOOL_NAME = `mcp__${OFFICECLI_SERVER_NAME}__officecli`;

export type PathZone = 'workspace' | 'out';
type PathDirection = 'read' | 'write';

interface PathEntry {
  readonly field: PathField;
  readonly zone: PathZone;
  /** Whether this path is read from or written to by the operation. */
  readonly direction: PathDirection;
  /** Workspace-relative display form (entries only exist for in-root paths). */
  readonly display: string;
}

interface PathProblem {
  readonly field: PathField;
  readonly reasonCode: string;
}

type OpKind = 'read' | 'write' | 'remove' | 'raw' | 'batch';

interface MergedAnalysis {
  readonly ops: readonly { kind: OpKind; command: string }[];
  readonly entries: readonly PathEntry[];
  readonly problem: PathProblem | null;
  /** Worst write target across ops (§6.4: 输出在 .trylo/out 可自动). */
  readonly writeTarget: 'out' | 'original' | 'missing';
  readonly subCount: number;
  readonly oversized: boolean;
  /** Batch contents the lexical classifier cannot verify (a --input
   *  payload file): never auto-allowed — a human must approve. */
  readonly unverifiedBatch: boolean;
}

// ── command-line tokenising (mirrors officecli's McpServer.Tokenize) ──

/**
 * Quote-aware tokenizer, kept in lockstep with the pinned server: splits on
 * whitespace, honours single/double quotes, and inside double quotes a
 * backslash only escapes `"` / `\` (any other backslash sequence is kept
 * verbatim so `text="A\nB"` reaches the prop parser intact). Never invokes
 * a shell — tokens go straight to the in-process command parser.
 */
export function tokenizeOfficecliCommand(line: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let inTok = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (
        ch === '\\' &&
        quote === '"' &&
        i + 1 < line.length &&
        (line[i + 1] === '"' || line[i + 1] === '\\')
      ) {
        buf += line[i + 1];
        i += 1;
      } else {
        buf += ch;
      }
      inTok = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inTok = true;
    } else if (/\s/.test(ch)) {
      if (inTok) {
        tokens.push(buf);
        buf = '';
        inTok = false;
      }
    } else {
      buf += ch;
      inTok = true;
    }
  }
  if (inTok) tokens.push(buf);
  return tokens;
}

function isOfficeCliToken(token: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? token;
  return /^officecli(\.exe)?$/i.test(base);
}

/**
 * Extract the argv vector from the tool input. The pinned MCP contract is
 * a single STRING command line; any other type (number, array, object,
 * missing) fails CLOSED as malformed input (§6.2 解析失败不能自动放行).
 * Strips an optional leading "officecli" token. Never throws.
 */
function extractArgv(
  input: Readonly<Record<string, unknown>>,
): { argv?: string[]; reasonCode?: string } {
  const raw = input['command'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { reasonCode: 'malformed_input' };
  }
  let argv = tokenizeOfficecliCommand(raw);
  if (argv.length > 0 && isOfficeCliToken(argv[0]!)) argv = argv.slice(1);
  if (argv.length === 0) return { reasonCode: 'malformed_input' };
  return { argv };
}

// ── path analysis ───────────────────────────────────────────────────

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function isWindowsRoot(canonicalRoot: string): boolean {
  return /^[a-zA-Z]:\//.test(canonicalRoot);
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Lexical verdict for ONE path value. `problem` is a deny-class outcome
 * (§6.4's forbidden list); `entry` carries the zone for in-root paths.
 */
function analyzePath(
  raw: string,
  field: PathField,
  direction: PathDirection,
  canonicalRoot: string,
  windowsFS: boolean,
): { kind: 'entry'; entry: PathEntry } | { kind: 'problem'; problem: PathProblem } {
  if (hasControlChars(raw)) {
    return { kind: 'problem', problem: { field, reasonCode: 'invalid_path' } };
  }
  const normalized = raw.replace(/\\/g, '/');
  // Device namespaces first — `\\.\` / `\\?\` also start with two separators.
  if (normalized.startsWith('//./') || normalized.startsWith('//?/')) {
    return { kind: 'problem', problem: { field, reasonCode: 'device_path' } };
  }
  if (normalized.startsWith('//')) {
    return { kind: 'problem', problem: { field, reasonCode: 'unc_path' } };
  }
  // `D:foo` (no separator) resolves against the CURRENT DIRECTORY of drive
  // D — a classic escape; only `D:/…` / `D:\…` are honest absolutes.
  if (/^[a-zA-Z]:(?![/\\]|$)/.test(raw)) {
    return { kind: 'problem', problem: { field, reasonCode: 'drive_relative_path' } };
  }
  const segments = normalized.split('/').filter((s) => s !== '');
  if (segments.length === 0) {
    return { kind: 'problem', problem: { field, reasonCode: 'invalid_path' } };
  }
  if (segments.some((s) => RESERVED_DEVICE_NAME.test(s))) {
    // Any path segment: Win32 device-name resolution applies at every
    // component for legacy APIs, so "docs/CON.docx" is as hostile as "CON.docx".
    return { kind: 'problem', problem: { field, reasonCode: 'reserved_device_name' } };
  }
  // §6.4: `..` is forbidden outright — not "unless it stays inside".
  if (segments.some((s) => s === '..')) {
    return { kind: 'problem', problem: { field, reasonCode: 'dotdot_segment' } };
  }
  const clean = segments.filter((s) => s !== '.');
  // "." / "./" resolve to the workspace root itself — not a usable document
  // target and produces an empty display; fail closed (§6.2).
  if (clean.length === 0) {
    return { kind: 'problem', problem: { field, reasonCode: 'invalid_path' } };
  }

  const isAbsolute = /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/');
  let full: string;
  if (isAbsolute) {
    if (/^[a-zA-Z]:/.test(normalized)) {
      const drive = normalized.slice(0, 1).toLowerCase();
      const rest = clean.slice(1).join('/');
      full = rest ? `${drive}:/${rest}` : `${drive}:`;
    } else {
      full = `/${clean.join('/')}`;
    }
  } else {
    full = `${canonicalRoot}/${clean.join('/')}`;
  }

  const rootKey = windowsFS ? canonicalRoot.toLowerCase() : canonicalRoot;
  const fullKey = windowsFS ? full.toLowerCase() : full;
  const inside =
    fullKey === rootKey ||
    (rootKey.length > 0 && fullKey.startsWith(`${rootKey}/`));
  if (!inside) {
    return { kind: 'problem', problem: { field, reasonCode: 'path_outside_workspace' } };
  }
  const rel = full.slice(canonicalRoot.length).replace(/^\//, '');
  const relKey = windowsFS ? rel.toLowerCase() : rel;
  const zone: PathZone =
    relKey === OUT_DIR_SEGMENTS || relKey.startsWith(`${OUT_DIR_SEGMENTS}/`) ? 'out' : 'workspace';
  return { kind: 'entry', entry: { field, zone, direction, display: rel } };
}

function pushPath(
  entries: PathEntry[],
  problems: PathProblem[],
  value: string,
  field: PathField,
  direction: PathDirection,
  canonicalRoot: string,
  windowsFS: boolean,
): void {
  const verdict = analyzePath(value, field, direction, canonicalRoot, windowsFS);
  if (verdict.kind === 'problem') {
    if (!problems.some((p) => p.reasonCode === verdict.problem.reasonCode)) {
      problems.push(verdict.problem);
    }
    return;
  }
  entries.push(verdict.entry);
}

// ── argv → verb + filesystem paths ──────────────────────────────────

/** Options that consume the NEXT token as their value. Mapped to how the
 *  value is treated: a filesystem path (with direction), an inline batch
 *  payload, a maybe-path (merge --data: inline JSON or a .json file), or a
 *  non-path value (prop/xpath/text/…) that must not be mistaken for a
 *  positional. */
const OPTION_VALUE_KIND: Readonly<
  Record<string, 'write-path' | 'read-path' | 'data-path' | 'inline-batch' | 'skip'>
> = {
  '--out': 'write-path',
  '-o': 'write-path',
  '--input': 'read-path',
  '--file': 'read-path',
  '--path': 'read-path',
  '--data': 'data-path',
  '--commands': 'inline-batch',
  '--type': 'skip',
  '--prop': 'skip',
  '--xpath': 'skip',
  '--action': 'skip',
  '--xml': 'skip',
  '--text': 'skip',
  '--page': 'skip',
  '--start': 'skip',
  '--end': 'skip',
  '--range': 'skip',
  '--cols': 'skip',
  '--format': 'skip',
  '--locale': 'skip',
  '--render': 'skip',
  '--grid': 'skip',
  '--limit': 'skip',
  '--max-lines': 'skip',
  '--start-cell': 'skip',
  '--screenshot-width': 'skip',
  '--screenshot-height': 'skip',
  '--parent': 'skip',
  '--selector': 'skip',
  '--mode': 'skip',
  '--to': 'skip',
  '--from': 'skip',
  '--after': 'skip',
  '--before': 'skip',
  '--index': 'skip',
  '--part': 'skip',
};

/** Boolean flags — they consume no value. */
const BOOLEAN_OPTIONS = new Set([
  '--json',
  '--force',
  '--browser',
  '--stdin',
  '--header',
  '--minimal',
  '--stop-on-error',
  '--best-effort',
  '--page-count',
  '--bare',
]);

interface SlotRule {
  readonly field: PathField;
  readonly direction: PathDirection;
}

/**
 * Positional slot rules: which positional indices ARE filesystem paths.
 * Everything else positional is an element selector (/slide[1]), a mode
 * (outline/text/…), a query expression, a help topic or a DOM part — never
 * a path (verified against CommandBuilder.* in the pinned 1.0.145 source).
 */
function positionalPathSlots(verb: string, docDirection: PathDirection): ReadonlyMap<number, SlotRule> {
  const slots = new Map<number, SlotRule>();
  switch (verb) {
    case 'help':
      return slots; // help topics only
    case 'create':
      slots.set(0, { field: 'output', direction: 'write' }); // output file
      return slots;
    case 'merge':
      slots.set(0, { field: 'file', direction: 'read' }); // template
      slots.set(1, { field: 'output', direction: 'write' }); // merged output
      return slots;
    default:
      // view/get/query/set/add/remove/move/validate/raw/batch:
      // slot 0 is the document.
      slots.set(0, { field: 'file', direction: docDirection });
      return slots;
  }
}

function verbKind(verb: string): OpKind | null {
  if (READ_COMMANDS.has(verb)) return 'read';
  if (WRITE_COMMANDS.has(verb)) return 'write';
  if (REMOVE_COMMANDS.has(verb)) return 'remove';
  if (RAW_COMMANDS.has(verb)) return 'raw';
  if (BATCH_COMMANDS.has(verb)) return 'batch';
  return null;
}

/** Direction implied by the verb for its document slot: reads and `raw`
 *  only inspect; everything else (incl. batch, remove) mutates. */
function verbDocDirection(verb: string, kind: OpKind): PathDirection {
  return kind === 'read' || verb === 'raw' ? 'read' : 'write';
}

interface ParsedCommandLine {
  readonly verb: string;
  readonly entries: PathEntry[];
  readonly problems: PathProblem[];
  /** Inline batch JSON found via `--commands` (unparsed string), if any. */
  readonly inlineBatchJson: string | null;
  /** A `--input <file>` batch payload file was given. */
  readonly batchInputFile: boolean;
}

/** Walk one argv vector: verb + positional path slots + path options. */
function parseCommandLine(
  argv: readonly string[],
  canonicalRoot: string,
  windowsFS: boolean,
): ParsedCommandLine {
  const verb = argv[0]!;
  const kind = verbKind(verb) ?? 'write';
  const docDirection = verbDocDirection(verb, kind);
  const entries: PathEntry[] = [];
  const problems: PathProblem[] = [];
  let inlineBatchJson: string | null = null;
  let batchInputFile = false;

  const slots = positionalPathSlots(verb, docDirection);
  const positionals: string[] = [];

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq >= 0 ? token.slice(0, eq) : token;
      const inline = eq >= 0 ? token.slice(eq + 1) : null;
      const optKind = OPTION_VALUE_KIND[name];
      if (optKind === undefined) {
        // Unknown long option: System.CommandLine would reject it; treat it
        // as value-consuming so its argument cannot be misread as a
        // positional path. A bare unknown flag consumes nothing.
        if (inline === null && !BOOLEAN_OPTIONS.has(name) && i + 1 < argv.length) i += 1;
        continue;
      }
      if (optKind === 'skip') {
        if (inline === null && !BOOLEAN_OPTIONS.has(name) && i + 1 < argv.length) i += 1;
        continue;
      }
      const value = inline ?? (i + 1 < argv.length ? argv[(i += 1)] : '');
      if (optKind === 'inline-batch') {
        if (value) inlineBatchJson = value;
        continue;
      }
      if (optKind === 'read-path') {
        if (value) {
          if (name === '--input') batchInputFile = true;
          pushPath(entries, problems, value, 'path', 'read', canonicalRoot, windowsFS);
        }
        continue;
      }
      if (optKind === 'write-path') {
        if (value) pushPath(entries, problems, value, 'output', 'write', canonicalRoot, windowsFS);
        continue;
      }
      // data-path: merge --data is inline JSON OR a path to a .json file.
      if (optKind === 'data-path' && value && /\.json$/i.test(value.trim())) {
        pushPath(entries, problems, value.trim(), 'path', 'read', canonicalRoot, windowsFS);
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      // Short options — only "-o" (write path) exists today.
      const name = token.slice(0, 2);
      const rest = token.slice(2);
      if (OPTION_VALUE_KIND[name] === 'write-path') {
        const value = rest.startsWith('=')
          ? rest.slice(1)
          : rest || (i + 1 < argv.length ? argv[(i += 1)] : '');
        if (value) pushPath(entries, problems, value, 'output', 'write', canonicalRoot, windowsFS);
      }
      continue;
    }
    positionals.push(token);
  }

  for (const [index, slot] of slots) {
    const token = positionals[index];
    if (token !== undefined) {
      pushPath(entries, problems, token, slot.field, slot.direction, canonicalRoot, windowsFS);
    }
  }

  return { verb, entries, problems, inlineBatchJson, batchInputFile };
}

// ── input analysis ──────────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJsonLength(value: Record<string, unknown>): number {
  try {
    return JSON.stringify(value)?.length ?? Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function writeTargetOf(entries: readonly PathEntry[]): 'out' | 'original' | 'missing' {
  const writes = entries.filter((e) => e.direction === 'write');
  if (writes.some((e) => e.zone === 'workspace')) return 'original';
  if (writes.some((e) => e.zone === 'out')) return 'out';
  return 'missing';
}

/** Analyse legacy structured path fields (file/output/path). The `file`
 *  field's direction follows the verb; output/path are write targets. */
function analyzeStructuredPaths(
  input: Readonly<Record<string, unknown>>,
  verbDirection: PathDirection,
  canonicalRoot: string,
  windowsFS: boolean,
): { entries: PathEntry[]; problem: PathProblem | null } {
  const entries: PathEntry[] = [];
  const problems: PathProblem[] = [];
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      problems.push({ field, reasonCode: 'malformed_path_field' });
      continue;
    }
    if (value.trim() === '') continue;
    const direction: PathDirection = field === 'file' ? verbDirection : 'write';
    pushPath(entries, problems, value, field, direction, canonicalRoot, windowsFS);
  }
  return { entries, problem: problems[0] ?? null };
}

interface BatchSub {
  readonly verb: string;
  readonly kind: OpKind;
}

/** Parse an inline `--commands` JSON payload: an array of batch items, each
 *  {command|op: "<verb>", …}. Returns a deny-class reason or the verb list. */
function parseInlineBatch(json: string): { subs?: BatchSub[]; reasonCode?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { reasonCode: 'malformed_batch' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { reasonCode: 'empty_batch' };
  }
  const subs: BatchSub[] = [];
  for (const element of parsed) {
    if (!isPlainRecord(element)) return { reasonCode: 'malformed_batch' };
    const rawVerb = element['command'] ?? element['op'];
    if (typeof rawVerb !== 'string' || rawVerb.trim() === '') {
      return { reasonCode: 'malformed_batch' };
    }
    // The batch item's `command` is normally a bare verb; tolerate a full
    // command line by taking its first token.
    const verb = (tokenizeOfficecliCommand(rawVerb.trim())[0] ?? '').trim();
    if (verb === 'batch') return { reasonCode: 'nested_batch' };
    if (BATCH_META_COMMANDS.has(verb)) {
      subs.push({ verb, kind: 'read' });
      continue;
    }
    const kind = verbKind(verb);
    if (kind === null) return { reasonCode: 'unknown_subcommand' };
    subs.push({ verb, kind });
  }
  return { subs };
}

/**
 * Full analysis of one officecli call. Never throws — every parse failure
 * becomes a deny-class `problem` or an unverifiable-batch flag, because
 * §6.2 forbids auto-allowing what could not be parsed.
 */
export function analyzeOfficecliInput(
  input: Readonly<Record<string, unknown>>,
  projectRoot: string,
): MergedAnalysis {
  const empty: MergedAnalysis = {
    ops: [],
    entries: [],
    problem: null,
    writeTarget: 'missing',
    subCount: 0,
    oversized: false,
    unverifiedBatch: false,
  };
  if (!isPlainRecord(input)) {
    return { ...empty, problem: { field: 'file', reasonCode: 'malformed_input' } };
  }

  const canonicalRoot = canonicalizeCwd(projectRoot);
  const windowsFS = isWindowsRoot(canonicalRoot);
  const oversized = stableJsonLength(input as Record<string, unknown>) > MAX_INPUT_JSON_LENGTH;

  const extracted = extractArgv(input);
  if (extracted.reasonCode || !extracted.argv) {
    return {
      ...empty,
      oversized,
      problem: { field: 'file', reasonCode: extracted.reasonCode ?? 'malformed_input' },
    };
  }
  const argv = extracted.argv;
  const verb = argv[0]!;
  if (!ALL_COMMANDS.has(verb)) {
    return { ...empty, oversized, problem: { field: 'file', reasonCode: 'unknown_command' } };
  }

  const kind = verbKind(verb)!;

  // ── batch: recursive classification, highest risk wins (§6.4) ──────
  if (kind === 'batch') {
    return analyzeBatch(input, argv, canonicalRoot, windowsFS, oversized, empty);
  }

  // ── single operation ───────────────────────────────────────────────
  const parsed = parseCommandLine(argv, canonicalRoot, windowsFS);
  const entries = [...parsed.entries];
  let problem: PathProblem | null = parsed.problems[0] ?? null;

  const verbDirection = verbDocDirection(verb, kind);
  const structured = analyzeStructuredPaths(input, verbDirection, canonicalRoot, windowsFS);
  entries.push(...structured.entries);
  if (!problem && structured.problem) problem = structured.problem;

  const ops: { kind: OpKind; command: string }[] = [{ kind, command: verb }];
  // A read verb with an explicit output (e.g. `view deck.pptx screenshot
  // --out shot.png`) WRITES a file — classify through the write matrix.
  if (kind === 'read' && entries.some((e) => e.direction === 'write')) {
    ops.push({ kind: 'write', command: verb });
  }

  return {
    ops,
    entries,
    problem,
    writeTarget: writeTargetOf(entries),
    subCount: 1,
    oversized,
    unverifiedBatch: false,
  };
}

function analyzeBatch(
  input: Readonly<Record<string, unknown>>,
  argv: readonly string[],
  canonicalRoot: string,
  windowsFS: boolean,
  oversized: boolean,
  empty: MergedAnalysis,
): MergedAnalysis {
  const parsed = parseCommandLine(argv, canonicalRoot, windowsFS);
  const entries = [...parsed.entries];
  let problem: PathProblem | null = parsed.problems[0] ?? null;

  // Structured top-level path fields ride along beside the batch (§6.4:
  // a rogue `file` must not pass unclassified).
  const structured = analyzeStructuredPaths(input, 'write', canonicalRoot, windowsFS);
  entries.push(...structured.entries);
  if (!problem && structured.problem) problem = structured.problem;

  const subOps: { kind: OpKind; command: string }[] = [{ kind: 'batch', command: 'batch' }];
  let unverifiedBatch = false;

  // Shape 1: inline JSON via --commands (the real CLI contract).
  if (parsed.inlineBatchJson !== null) {
    const result = parseInlineBatch(parsed.inlineBatchJson);
    if (result.reasonCode) {
      return { ...empty, oversized, problem: { field: 'file', reasonCode: result.reasonCode } };
    }
    for (const sub of result.subs!) subOps.push({ kind: sub.kind, command: sub.verb });
  } else if (parsed.batchInputFile) {
    // Shape 2: --input <json file>. The payload lives on disk; this lexical
    // module cannot read it — its contents are UNVERIFIABLE, so the batch
    // can never be auto-allowed (a human approves or denies).
    unverifiedBatch = true;
  } else {
    // Shape 3: legacy structured arrays (batch/operations/commands).
    let found = false;
    for (const field of BATCH_ARRAY_FIELDS) {
      const value = input[field];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) {
        return { ...empty, oversized, problem: { field: 'file', reasonCode: 'malformed_batch' } };
      }
      found = true;
      if (value.length === 0) {
        return { ...empty, oversized, problem: { field: 'file', reasonCode: 'empty_batch' } };
      }
      for (const element of value) {
        // Batch items are OBJECTS in the pinned protocol ({command, …});
        // a bare string fails closed — parse failure never auto-allows.
        if (!isPlainRecord(element)) {
          return { ...empty, oversized, problem: { field: 'file', reasonCode: 'malformed_batch' } };
        }
        const rawVerb = element['command'] ?? element['op'];
        if (typeof rawVerb !== 'string' || rawVerb.trim() === '') {
          return { ...empty, oversized, problem: { field: 'file', reasonCode: 'malformed_batch' } };
        }
        const subArgv = tokenizeOfficecliCommand(rawVerb.trim());
        const subVerb = subArgv[0]!;
        if (subVerb === 'batch') {
          return { ...empty, oversized, problem: { field: 'file', reasonCode: 'nested_batch' } };
        }
        const subKind = verbKind(subVerb);
        if (subKind === null) {
          return { ...empty, oversized, problem: { field: 'file', reasonCode: 'unknown_subcommand' } };
        }
        // A full command line in `command` contributes its own paths.
        if (subArgv.length > 1) {
          const subParsed = parseCommandLine(subArgv, canonicalRoot, windowsFS);
          entries.push(...subParsed.entries);
          if (subParsed.problems[0] && !problem) problem = subParsed.problems[0];
        }
        // Structured sibling fields (file/output/path) on the batch item.
        const subDirection = verbDocDirection(subVerb, subKind);
        const subPaths = analyzeStructuredPaths(element, subDirection, canonicalRoot, windowsFS);
        entries.push(...subPaths.entries);
        if (subPaths.problem && !problem) problem = subPaths.problem;
        subOps.push({ kind: subKind, command: subVerb });
      }
      break; // first recognized array field wins
    }
    if (!found) {
      // Shape 4: no inline JSON, no --input file, no structured arrays — a
      // batch whose payload would arrive on stdin. Its contents never reach
      // the classifier, so it CANNOT be parsed or verified: fail CLOSED
      // (deny at every level — §6.2/§6.4 解析失败不能自动放行).
      return { ...empty, oversized, problem: { field: 'file', reasonCode: 'malformed_batch' } };
    }
  }

  return {
    ops: subOps,
    entries,
    problem,
    writeTarget: writeTargetOf(entries),
    subCount: Math.max(0, subOps.length - 1),
    oversized,
    unverifiedBatch,
  };
}

// ── decision ────────────────────────────────────────────────────────

const DENY_MESSAGES: Readonly<Record<string, string>> = {
  malformed_input:
    'Denied: the officecli input could not be parsed safely. Provide `command` as a string command line (e.g. "view deck.pptx outline" or "create .trylo/out/deck.pptx") or an argv array of strings.',
  unknown_command:
    "Denied: this command is not part of the pinned officecli command set (create/view/get/query/set/add/remove/move/validate/batch/raw/merge/help).",
  malformed_path_field:
    'Denied: the file/output/path field must be a string path.',
  invalid_path: "Denied: the '{field}' path contains control characters.",
  unc_path: 'Denied: UNC paths are not allowed in officecli tool input.',
  device_path: 'Denied: device-namespace paths are not allowed in officecli tool input.',
  drive_relative_path:
    'Denied: drive-relative paths (e.g. "D:file") are not allowed; use a full workspace path.',
  reserved_device_name:
    'Denied: the path uses a reserved Windows device name.',
  dotdot_segment:
    "Denied: '..' segments are not allowed in officecli paths; keep paths inside the workspace.",
  path_outside_workspace:
    'Denied: the path resolves outside the workspace root; Office tool paths must stay inside the workspace (deliverables belong in .trylo/out).',
  write_denied_read_only:
    'Denied: this conversation is read-only. officecli write commands (create/set/add/move/merge) require a higher permission level.',
  remove_denied_read_only:
    'Denied: this conversation is read-only; remove is unavailable.',
  raw_denied_read_only:
    'Denied: this conversation is read-only; raw is unavailable.',
  batch_denied_read_only:
    'Denied: this conversation is read-only; batch is unavailable.',
  malformed_batch:
    'Denied: a batch must be an array of {command, …} operations under the batch/operations/commands field.',
  empty_batch: 'Denied: the batch contained no operations.',
  nested_batch: 'Denied: nested batch operations are not allowed.',
  unknown_subcommand:
    'Denied: the batch contains a sub-command outside the pinned officecli command set.',
};

function denyMessage(reasonCode: string): string {
  return DENY_MESSAGES[reasonCode] ?? `Denied: ${reasonCode}.`;
}

function buildAudit(
  context: ToolRiskContext,
  analysis: MergedAnalysis,
  behavior: SafeAudit['behavior'],
  risk: SafeAudit['risk'],
  reasonCode: string,
): SafeAudit {
  return {
    at: context.at,
    profileId: context.profileId,
    packageId: context.packageId,
    toolName: context.toolName,
    behavior,
    risk,
    reasonCode,
    inputDigest: inputDigestOf(context.input),
    pathZones: analysis.entries.map((e) => ({ field: e.field, zone: e.zone })),
  };
}

function denyDecision(
  context: ToolRiskContext,
  analysis: MergedAnalysis,
  reasonCode: string,
): ToolRiskDecision {
  return {
    behavior: 'deny',
    reasonCode,
    userMessage: denyMessage(reasonCode),
    audit: buildAudit(context, analysis, 'deny', null, reasonCode),
  };
}

function promptDecision(
  context: ToolRiskContext,
  analysis: MergedAnalysis,
  risk: 'external' | 'sensitive' | 'destructive',
  reasonCode: string,
  reasonText: string,
): ToolRiskDecision {
  return {
    behavior: 'prompt',
    risk,
    reasonCode,
    preview: buildOfficecliApprovalPreview(context.input, context.projectRoot, reasonText),
    audit: buildAudit(context, analysis, 'prompt', risk, reasonCode),
  };
}

function autoAllowDecision(
  context: ToolRiskContext,
  analysis: MergedAnalysis,
  risk: 'read' | 'workspace-write',
  reasonCode: string,
): ToolRiskDecision {
  return {
    behavior: 'auto_allow',
    risk,
    reasonCode,
    audit: buildAudit(context, analysis, 'auto_allow', risk, reasonCode),
  };
}

/** The §6.3 × §6.4 matrix. Pure; never reads a clock or disk. */
export function classifyOfficecli(context: ToolRiskContext): ToolRiskDecision {
  const analysis = analyzeOfficecliInput(context.input, context.projectRoot);

  // Path / parse problems are level-independent denials.
  if (analysis.problem) {
    return denyDecision(context, analysis, analysis.problem.reasonCode);
  }

  const has = (kind: OpKind): boolean => analysis.ops.some((o) => o.kind === kind);
  const level = context.permissionLevel;
  const oversized = analysis.oversized;

  // remove — destructive: A 完全自动下直接放行（仅 read_only 拒绝），否则审批
  if (has('remove')) {
    if (level === 'read_only') return denyDecision(context, analysis, 'remove_denied_read_only');
    if (level === 'unrestricted') return autoAllowDecision(context, analysis, 'workspace-write', 'remove_unrestricted');
    return promptDecision(
      context,
      analysis,
      'destructive',
      'remove_requires_approval',
      'remove 为不可逆删除操作，始终需要审批',
    );
  }

  // raw — A 完全自动下直接放行
  if (has('raw')) {
    if (level === 'read_only') return denyDecision(context, analysis, 'raw_denied_read_only');
    if (level === 'unrestricted') return autoAllowDecision(context, analysis, 'workspace-write', 'raw_unrestricted');
    return promptDecision(
      context,
      analysis,
      'sensitive',
      'raw_requires_approval',
      'raw 命令不做参数风险推断，始终需要审批',
    );
  }

  // batch --input 放行：A 完全自动下不卡
  if (analysis.unverifiedBatch) {
    if (level === 'read_only') return denyDecision(context, analysis, 'batch_denied_read_only');
    if (level === 'unrestricted') return autoAllowDecision(context, analysis, 'workspace-write', 'batch_unrestricted');
    return promptDecision(
      context,
      analysis,
      'sensitive',
      'batch_unverified',
      'batch 载荷来自 --input 文件，内容无法静态核验，需人工审批',
    );
  }

  // write — workspace-write with a target-zone split (§6.4). A 完全自动下 oversized 也不卡
  if (has('write')) {
    if (level === 'read_only') return denyDecision(context, analysis, 'write_denied_read_only');
    if (analysis.writeTarget === 'missing') {
      if (level === 'unrestricted') return autoAllowDecision(context, analysis, 'workspace-write', 'write_target_unknown_unrestricted');
      return promptDecision(
        context,
        analysis,
        'sensitive',
        'write_target_unknown',
        '无法确定写入目标路径（缺少 file/output/path），需人工确认',
      );
    }
    if (analysis.writeTarget === 'original') {
      if (level === 'unrestricted') {
        // A: 完全自动下即使修改原文件也只提醒不卡
        return autoAllowDecision(context, analysis, 'workspace-write', 'modifies_original');
      }
      return promptDecision(
        context,
        analysis,
        'sensitive',
        'modifies_original',
        '将修改工作区内的原文件（默认策略是复制到 .trylo/out 再修改）',
      );
    }
    // writeTarget === 'out'
    if (level === 'ask') {
      return promptDecision(
        context,
        analysis,
        'sensitive',
        'ask_level_write',
        '当前权限级别为「每次审批」：写入 .trylo/out 也需确认',
      );
    }
    // A: unrestricted 下 oversized 也不卡（仅记录审计）
    return autoAllowDecision(context, analysis, 'workspace-write', 'write_to_out');
  }

  // read — A 完全自动下 oversized 也不卡
  if (oversized && level !== 'unrestricted') {
    return promptDecision(
      context,
      analysis,
      'sensitive',
      'input_too_large',
      '输入超过自动分类上限，需人工确认',
    );
  }
  return autoAllowDecision(context, analysis, 'read', 'workspace_read');
}

// ── safe preview ────────────────────────────────────────────────────

/** Collect raw path-bearing tokens/fields from the input for preview
 *  display (validation happens elsewhere). Mirrors parseCommandLine's
 *  positional slots and path options. */
function collectRawPathValues(input: Readonly<Record<string, unknown>>): string[] {
  const targets: string[] = [];
  const extracted = extractArgv(input);
  if (!extracted.argv) {
    for (const field of PATH_FIELDS) {
      const value = input[field];
      if (typeof value === 'string' && value.trim() !== '') targets.push(value);
    }
    return targets;
  }
  const argv = extracted.argv;
  const verb = argv[0]!;
  const kind = verbKind(verb) ?? 'write';
  const slots = positionalPathSlots(verb, verbDocDirection(verb, kind));
  const positionals: string[] = [];

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq >= 0 ? token.slice(0, eq) : token;
      const inline = eq >= 0 ? token.slice(eq + 1) : null;
      const optKind = OPTION_VALUE_KIND[name];
      if (optKind === 'write-path' || optKind === 'read-path') {
        const value = inline ?? (i + 1 < argv.length ? argv[i + 1] : '');
        if (value) targets.push(value);
        if (inline === null && i + 1 < argv.length) i += 1;
      } else if (optKind === 'data-path') {
        const value = inline ?? (i + 1 < argv.length ? argv[i + 1] : '');
        if (value && /\.json$/i.test(value.trim())) targets.push(value.trim());
        if (inline === null && i + 1 < argv.length) i += 1;
      } else if (optKind !== undefined && optKind !== 'inline-batch') {
        if (inline === null && !BOOLEAN_OPTIONS.has(name) && i + 1 < argv.length) i += 1;
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      if (token.slice(0, 2) === '-o') {
        const rest = token.slice(2);
        const value = rest.startsWith('=')
          ? rest.slice(1)
          : rest || (i + 1 < argv.length ? argv[i + 1] : '');
        if (value) targets.push(value);
        if (!rest && i + 1 < argv.length) i += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  for (const index of slots.keys()) {
    if (positionals[index] !== undefined) targets.push(positionals[index]!);
  }
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim() !== '') targets.push(value);
  }
  return targets;
}

/**
 * Safe, redacted ApprovalPreview for an officecli request. Shown in the
 * ApprovalCard and persisted WITH the approval message — it carries the
 * command and PATHS only (paths the user must see to decide), never the
 * document body, query text, props or any other content field.
 */
export function buildOfficecliApprovalPreview(
  input: Readonly<Record<string, unknown>>,
  projectRoot: string,
  reasonText?: string,
): ApprovalPreview {
  try {
    const record = isPlainRecord(input) ? input : {};
    const command =
      typeof record['command'] === 'string'
        ? record['command'].trim()
        : Array.isArray(record['command'])
          ? (record['command'] as unknown[]).map((t) => String(t)).join(' ')
          : '';
    const canonicalRoot = canonicalizeCwd(projectRoot);
    const windowsFS = isWindowsRoot(canonicalRoot);

    const targets: string[] = [];
    for (const value of collectRawPathValues(record)) {
      const verdict = analyzePath(value, 'file', 'read', canonicalRoot, windowsFS);
      targets.push(
        verdict.kind === 'entry' ? verdict.entry.display : `${value}（工作区外或不安全）`,
      );
    }

    const label = command || '未知命令';
    const target =
      targets.length > 0 ? `${label} · ${targets.join(' ； ')}` : label;
    // A batch preview carries the sub-command count so the approver can see
    // the blast radius at a glance (§6.4 递归取最高风险).
    const subCount = /^batch(\s|$)/.test(command)
      ? analyzeOfficecliInput(record, projectRoot).subCount
      : 0;
    const reason = reasonText ?? defaultRiskText(command, subCount);
    return {
      kind: 'summary',
      title: 'Office 文档操作',
      target,
      reason,
    };
  } catch {
    return {
      kind: 'summary',
      title: 'Office 文档操作',
      target: 'officecli',
      reason: '未能解析此请求的参数',
    };
  }
}

function defaultRiskText(command: string, subCount = 0): string {
  const verb = command.split(/\s+/, 1)[0] ?? '';
  if (verb === 'batch') {
    return subCount > 0
      ? `批量操作（${subCount} 个子命令），按最高风险子操作审批`
      : '批量操作，按最高风险子操作审批';
  }
  switch (verbKind(verb)) {
    case 'read':
      return '读取工作区内文档';
    case 'write':
      return '写入/修改文档';
    case 'remove':
      return '删除操作（不可逆）';
    case 'raw':
      return 'raw 原生命令';
    default:
      return 'OfficeCLI 工具调用';
  }
}

/** The classifier registered by the router (manifest twin: classifierId
 *  `officecli`, server `trylo-office`, expectedTools `['officecli']`). */
export const officecliClassifier: PackageRiskClassifier = {
  id: 'officecli',
  serverName: OFFICECLI_SERVER_NAME,
  expectedTools: [OFFICECLI_TOOL_NAME],
  classify: classifyOfficecli,
};

export { OFFICECLI_SERVER_NAME, OFFICECLI_TOOL_NAME, ALL_COMMANDS as OFFICECLI_COMMANDS };

export default officecliClassifier;
