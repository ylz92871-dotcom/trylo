// Trylo Desktop — ApprovalPreview (P3, spec §4.5 / §4.6).
//
// The unified, safe preview of a pending approval request. Both
// Code (`ControlPermissionFrame.input`) and Work (`approval.details`)
// are projected through the same shape so the ApprovalCard can
// render one presentation from two different authority surfaces.
//
// Why this is its own module:
//   - The tool input is UNTRUSTED content from the runtime. It may
//     carry arbitrary file paths, large proposed content, and
//     sensitive args. The preview builder must parse it defensively,
//     never trust a field name it has not verified, and MUST reject
//     paths that escape the project root.
//   - The builder returns a `kind` and a `path` (or `command`) — the
//     renderer never re-parses the raw input. This is the firewall
//     that keeps dangerous content out of the React tree.
//   - Persistence: the FULL raw input is NOT written to the
//     ConversationRecord. Only the parsed `ApprovalPreview` shape
//     is persisted, and only when the request is `pending` or
//     `approved/denied` for the timeline row. Sensitive fields are
//     summarized, not echoed.
//   - The path safety check is single-sourced here so the diff
//     panel and the parser can never disagree on what is "in the
//     project root".
//
// Per-tool parsers live in PARSERS below. Unknown tools return
// `unavailable`; the card still renders the safe summary.

import type { FilePath } from '../host-adapter/types';
import {
  OFFICECLI_TOOL_NAME,
  buildOfficecliApprovalPreview,
} from '../tooling/classifiers/officecli-classifier';
import {
  PLAYWRIGHT_EXPECTED_TOOLS,
  PLAYWRIGHT_SERVER_NAME,
  buildPlaywrightApprovalPreview,
} from '../tooling/classifiers/playwright-classifier';
import {
  CHROME_DEVTOOLS_EXPECTED_TOOLS,
  CHROME_DEVTOOLS_SERVER_NAME,
  buildChromeDevtoolsApprovalPreview,
} from '../tooling/classifiers/chrome-devtools-classifier';
import {
  WINDOWS_EXPECTED_TOOLS,
  WINDOWS_SERVER_NAME,
  buildWindowsApprovalPreview,
} from '../tooling/classifiers/windows-mcp-classifier';
import {
  CAD_EDA_CLASSIFIERS,
  buildCadEdaApprovalPreviewForTool,
} from '../tooling/classifiers/cad-eda-classifier';

export type ApprovalPreviewKind =
  | 'diff'
  | 'command'
  | 'network'
  | 'desktop'
  | 'summary'
  | 'unavailable';

export interface ApprovalDiffPreview {
  readonly path: string;
  readonly oldPath?: string;
  /** Project-root-relative original content (what is on disk now). */
  readonly original: string;
  /** Proposed modified content. */
  readonly modified: string;
  readonly additions?: number;
  readonly deletions?: number;
  /** True when the original or modified content was capped (2 MiB
   *  default, matching the Git diff budget). */
  readonly truncated: boolean;
}

export interface ApprovalPreview {
  readonly kind: ApprovalPreviewKind;
  readonly title: string;
  readonly target?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly diff?: ApprovalDiffPreview;
  readonly reason?: string;
  /** `kind: 'desktop'` only — the visual facts of a Windows desktop
   *  action. Per acceptance C06 the TYPED TEXT itself is never echoed;
   *  only its length is. */
  readonly actionLabel?: string;
  readonly textChars?: number;
}

export interface BuildPreviewArgs {
  /** The tool name as emitted by the runtime (e.g. "Write", "Edit",
   *  "Bash", "write_file"). Unknown tools are mapped to
   *  `unavailable`. */
  readonly toolName: string;
  /** The raw tool input. Treated as UNTRUSTED; only known fields
   *  are read. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Project root used to resolve relative paths and to reject
   *  any path that escapes it. */
  readonly projectRoot: FilePath;
  /** Per-tool preview size cap (bytes). Defaults to 2 MiB. */
  readonly maxBytes?: number;
  /** Read the current on-disk content for a path. Injected so
   *  tests can stub the file system; production routes through
   *  the host adapter. */
  readonly readFile?: (path: string) => Promise<string | null>;
}

type ParserResult =
  | { readonly ok: true; readonly preview: ApprovalPreview }
  | { readonly ok: false; readonly reason: string };

type Parser = (args: BuildPreviewArgs) => Promise<ParserResult>;

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Resolve a path against the project root, rejecting:
 *   - absolute paths outside the root (Windows + POSIX);
 *   - any `..` segment in the path (the renderer must hand us
 *     a path that's already inside the root; if a tool wants
 *     to write outside, that is a host-level concern, not a
 *     preview concern);
 *   - drive-letter carry-over (a `C:` segment inside a POSIX
 *     path tail is a sign of hostile input).
 *
 * On success returns the project-root-relative path (forward
 * slashes); on rejection returns `null` so the caller can fall
 * back to a "this request's target is outside the project"
 * message. Symlink escapes are not detectable from JS alone —
 * the Rust host re-validates after `fs::canonicalize`, so this
 * JS gate is a UI safety net, not the only gate.
 */
export function safeRelativePath(
  raw: string,
  projectRoot: FilePath,
): string | null {
  if (raw.length === 0) return null;
  // Reject obvious absolute paths (Windows + POSIX) — the
  // project root is always a directory and the renderer must
  // hand us relative paths in tool input. An absolute path
  // here is a red flag.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')) return null;
  const pathParts = raw.split(/[\\/]+/).filter(Boolean);
  // Reject any `..` — the preview is project-relative and a
  // `..` is the canonical sign of a path that wants to escape
  // the root. The Rust host is the source of truth for any
  // legitimate need to write elsewhere.
  for (const seg of pathParts) {
    if (seg === '..') return null;
  }
  // Reject drive-letter carry-over: a `C:` segment anywhere in
  // the path is a sign of a Windows-absolute redirect embedded
  // inside a POSIX-style relative path. (Pure absolute Windows
  // paths are caught by the `^[a-zA-Z]:[\\/]` check above; this
  // one handles the `C:bad.ts` case where the drive letter
  // appears mid-tail without a leading separator.)
  for (const seg of pathParts) {
    if (/^[a-zA-Z]:/.test(seg)) return null;
  }
  // The project root argument is currently unused beyond the
  // absolute-path gate; we accept it for API symmetry with
  // future checks (e.g. "must live under a known subdir").
  void projectRoot;
  return pathParts.join('/');
}

/** Truncate text to a byte cap, marking truncation. */
function truncate(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes <= maxBytes) return { value, truncated: false };
  // Slice by characters; TextEncoder round-trip can over-shoot on
  // multi-byte, but the rendered cap is best-effort. The strict
  // cap is re-enforced at the Rust diff surface.
  const slice = value.slice(0, Math.max(0, maxBytes));
  return { value: slice, truncated: true };
}

/** Add up diff lines between original and modified. A 1-line
 *  `+` count means insertions; `-` deletions. */
function countDiffLines(original: string, modified: string): { additions: number; deletions: number } {
  const oldLines = original.split(/\r?\n/).length;
  const newLines = modified.split(/\r?\n/).length;
  if (newLines > oldLines) {
    return { additions: newLines - oldLines, deletions: 0 };
  }
  if (oldLines > newLines) {
    return { additions: 0, deletions: oldLines - newLines };
  }
  return { additions: 0, deletions: 0 };
}

async function readOriginal(
  absPath: string,
  readFile: ((path: string) => Promise<string | null>) | undefined,
  projectRoot: FilePath,
): Promise<string | null> {
  if (!readFile) return null;
  try {
    return await readFile(absPath);
  } catch {
    void projectRoot;
    return null;
  }
}

/* ───────────────────── Per-tool parsers ───────────────────── */

const parseWrite: Parser = async (args) => {
  const record = asRecord(args.input) ?? {};
  const rawPath = asString(record['file_path']) ?? asString(record['path']);
  if (!rawPath) {
    return { ok: false, reason: 'missing file path' };
  }
  const rel = safeRelativePath(rawPath, args.projectRoot);
  if (!rel) {
    return {
      ok: true,
      preview: {
        kind: 'summary',
        title: '写入文件',
        target: rawPath,
        reason: '路径在项目外或包含不安全段，未生成预览',
      },
    };
  }
  const content = asString(record['content']) ?? '';
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
  const modifiedTrunc = truncate(content, maxBytes);
  const abs = `${args.projectRoot}/${rel}`;
  const original = (await readOriginal(abs, args.readFile, args.projectRoot)) ?? '';
  const originalTrunc = truncate(original, maxBytes);
  const { additions, deletions } = countDiffLines(originalTrunc.value, modifiedTrunc.value);
  return {
    ok: true,
    preview: {
      kind: 'diff',
      title: '编辑文件',
      target: rel,
      diff: {
        path: rel,
        original: originalTrunc.value,
        modified: modifiedTrunc.value,
        additions,
        deletions,
        truncated: modifiedTrunc.truncated || originalTrunc.truncated,
      },
    },
  };
};

const parseEdit: Parser = async (args) => {
  const record = asRecord(args.input) ?? {};
  const rawPath = asString(record['file_path']) ?? asString(record['path']);
  if (!rawPath) return { ok: false, reason: 'missing file path' };
  const rel = safeRelativePath(rawPath, args.projectRoot);
  if (!rel) {
    return {
      ok: true,
      preview: {
        kind: 'summary',
        title: '编辑文件',
        target: rawPath,
        reason: '路径在项目外或包含不安全段，未生成预览',
      },
    };
  }
  const newString = asString(record['new_string']) ?? asString(record['newString']) ?? '';
  const oldString = asString(record['old_string']) ?? asString(record['oldString']) ?? '';
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
  const abs = `${args.projectRoot}/${rel}`;
  const original = (await readOriginal(abs, args.readFile, args.projectRoot)) ?? '';
  let modified: string;
  if (oldString.length > 0 && original.includes(oldString)) {
    // Build the modified text by replacing oldString with newString,
    // in the FIRST occurrence only. This matches the upstream
    // `Edit` tool's contract; for safety we do not run a global
    // replace because the tool itself expects uniqueness.
    modified = original.replace(oldString, newString);
  } else {
    // No anchor or anchor not present — show the proposed new
    // content as-is. The card still lets the user approve/deny;
    // a real Edit that misses its anchor is a tool bug, not a UI
    // safety problem.
    modified = newString;
  }
  const modifiedTrunc = truncate(modified, maxBytes);
  const originalTrunc = truncate(original, maxBytes);
  const { additions, deletions } = countDiffLines(originalTrunc.value, modifiedTrunc.value);
  return {
    ok: true,
    preview: {
      kind: 'diff',
      title: '编辑文件',
      target: rel,
      diff: {
        path: rel,
        original: originalTrunc.value,
        modified: modifiedTrunc.value,
        additions,
        deletions,
        truncated: modifiedTrunc.truncated || originalTrunc.truncated,
      },
    },
  };
};

const parseMultiEdit: Parser = async (args) => {
  // MultiEdit sends a `edits` array. We summarise; rendering each
  // edit individually is out of scope for P3 (the user can still
  // approve/deny the whole bundle).
  const record = asRecord(args.input) ?? {};
  const rawPath = asString(record['file_path']) ?? asString(record['path']);
  if (!rawPath) return { ok: false, reason: 'missing file path' };
  const rel = safeRelativePath(rawPath, args.projectRoot);
  if (!rel) {
    return {
      ok: true,
      preview: {
        kind: 'summary',
        title: '多次编辑',
        target: rawPath,
        reason: '路径在项目外，未生成预览',
      },
    };
  }
  const edits = asArray(record['edits']) ?? [];
  return {
    ok: true,
    preview: {
      kind: 'summary',
      title: '多次编辑',
      target: rel,
      reason: `${edits.length} 处编辑待预览`,
    },
  };
};

const parseBash: Parser = async (args) => {
  const record = asRecord(args.input) ?? {};
  const cmd = asString(record['command']);
  if (!cmd) return { ok: false, reason: 'missing command' };
  const cwd = asString(record['cwd']);
  return {
    ok: true,
    preview: {
      kind: 'command',
      title: '运行命令',
      command: cmd,
      ...(cwd ? { cwd } : {}),
    },
  };
};

const parseNetwork: Parser = async (args) => {
  const record = asRecord(args.input) ?? {};
  const url = asString(record['url']);
  if (!url) return { ok: false, reason: 'missing url' };
  return {
    ok: true,
    preview: {
      kind: 'network',
      title: '外部请求',
      target: url,
    },
  };
};

/* PR-2 (tool-extension spec §12.2): the classifier-managed MCP tools get
 * the SAME safe-preview treatment. The officecli builder is redaction-
 * first — command and paths only, never document content or query text —
 * and never throws, so an unexpected input still yields a renderable
 * summary card. */
const parseOfficecliMcp: Parser = async (args) => ({
  ok: true,
  preview: buildOfficecliApprovalPreview(args.input, args.projectRoot),
});

/* PR-3 (§6.5): the Playwright tools get the same redaction-first treatment
 * — action + origin + element description only. Typed text, form values,
 * evaluated code and dialog payloads are NEVER echoed. */
const parsePlaywrightMcp: Parser = async (args) => ({
  ok: true,
  preview: buildPlaywrightApprovalPreview({ toolName: args.toolName, input: args.input }),
});

/* PR-6 (§6.6): the Windows desktop tools get the same redaction-first
 * treatment — tool class + target shape (element label / coordinates).
 * Typed text, shortcut combos and app/executable names are NEVER echoed. */
const parseWindowsMcp: Parser = async (args) => ({
  ok: true,
  preview: buildWindowsApprovalPreview({ toolName: args.toolName, input: args.input }),
});

/* PR-7 (§6.5 / §4.1): the Chrome DevTools debug tools — action class +
 * target shape (origin / snapshot uid / file-write intent). Typed values,
 * evaluated scripts and dialog payloads are NEVER echoed. */
const parseChromeDevtoolsMcp: Parser = async (args) => ({
  ok: true,
  preview: buildChromeDevtoolsApprovalPreview({ toolName: args.toolName, input: args.input }),
});

/* TRYLO-CAD-EDA-TOOL-ADAPTER §7: the six CAD/EDA adapters — app label +
 * tool name only. Geometry parameters, coordinates and embedded scripts
 * are NEVER echoed. */
const parseCadEdaMcp: Parser = async (args) => ({
  ok: true,
  preview: buildCadEdaApprovalPreviewForTool(args.toolName),
});

/* Map tool name → parser. Both the Claude Code names and the cowork
 * `write_file` / `edit_file` / `run_command` aliases are
 * registered; unknown names fall through to `unavailable`. */
const PARSERS: Readonly<Record<string, Parser>> = (() => {
  const parsers: Record<string, Parser> = {
    Write: parseWrite,
    Edit: parseEdit,
    MultiEdit: parseMultiEdit,
    Bash: parseBash,
    write_file: parseWrite,
    edit_file: parseEdit,
    multi_edit: parseMultiEdit,
    run_command: parseBash,
    web_search: parseNetwork,
    http_request: parseNetwork,
    WebFetch: parseNetwork,
    WebSearch: parseNetwork,
    [OFFICECLI_TOOL_NAME]: parseOfficecliMcp,
  };
  for (const full of PLAYWRIGHT_EXPECTED_TOOLS) {
    // Guard: the manifest twin contract pins the server prefix (the
    // cross-package test enforces it), but stay defensive here.
    if (full.startsWith(`mcp__${PLAYWRIGHT_SERVER_NAME}__`)) {
      parsers[full] = parsePlaywrightMcp;
    }
  }
  for (const full of WINDOWS_EXPECTED_TOOLS) {
    if (full.startsWith(`mcp__${WINDOWS_SERVER_NAME}__`)) {
      parsers[full] = parseWindowsMcp;
    }
  }
  for (const full of CHROME_DEVTOOLS_EXPECTED_TOOLS) {
    if (full.startsWith(`mcp__${CHROME_DEVTOOLS_SERVER_NAME}__`)) {
      parsers[full] = parseChromeDevtoolsMcp;
    }
  }
  for (const classifier of CAD_EDA_CLASSIFIERS) {
    for (const full of classifier.expectedTools) {
      parsers[full] = parseCadEdaMcp;
    }
  }
  return parsers;
})();

/** Build a safe preview for one pending request. Returns
 *  `kind: 'unavailable'` (NOT throws) when the tool name is
 *  unknown or the parser cannot produce a preview — the card
 *  must still render a decision surface. */
export async function buildApprovalPreview(
  args: BuildPreviewArgs,
): Promise<ApprovalPreview> {
  const parser = PARSERS[args.toolName];
  if (!parser) {
    return {
      kind: 'unavailable',
      title: '权限请求',
      target: args.toolName,
      reason: '此请求未提供可预览补丁',
    };
  }
  try {
    const result = await parser(args);
    if (result.ok) return result.preview;
    return {
      kind: 'unavailable',
      title: '权限请求',
      target: args.toolName,
      reason: result.reason,
    };
  } catch {
    return {
      kind: 'unavailable',
      title: '权限请求',
      target: args.toolName,
      reason: '此请求未提供可预览补丁',
    };
  }
}

/** Public list of supported tool names — used by the card to label
 *  the kind chip and by tests to lock the contract. */
export const SUPPORTED_PREVIEW_TOOLS: ReadonlySet<string> = new Set(
  Object.keys(PARSERS),
);
