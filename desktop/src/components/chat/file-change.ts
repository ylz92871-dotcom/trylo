// Trylo Desktop — file-change model for IDE-style edit cards.
//
// Pure projection from a file-mutating tool invocation (Edit / MultiEdit /
// Write / NotebookEdit) to the data an IDE-style change card needs:
//   - the changed file path
//   - added / removed line counts (the green "+N" / red "-N" badges)
//   - a line-level diff for the expandable body
//
// Line diff is a classic LCS over lines — exact old/new strings are small
// (a hunk, or a full new file for Write) so O(n*m) is fine.

export type FileChangeTool = 'edit' | 'multiedit' | 'write' | 'notebookedit';

export interface DiffLine {
  readonly kind: 'add' | 'del' | 'context';
  readonly text: string;
}

export interface FileChange {
  /** Absolute file path as emitted by the tool. */
  readonly path: string;
  /** True for Write (no pre-existing content replaced). */
  readonly isNew: boolean;
  readonly additions: number;
  readonly deletions: number;
  /** Flattened diff lines across all hunks (MultiEdit). */
  readonly lines: readonly DiffLine[];
  /** Number of hunks (1 for Edit/Write, N for MultiEdit). */
  readonly hunks: number;
}

/** Normalise the raw tool name to a supported file-change tool, or null
 *  when the invocation doesn't mutate a single file. */
export function fileChangeTool(tool: string): FileChangeTool | null {
  const t = String(tool || '').toLowerCase();
  if (t === 'edit') return 'edit';
  if (t === 'multiedit') return 'multiedit';
  if (t === 'write') return 'write';
  if (t === 'notebookedit' || t === 'notebook_edit') return 'notebookedit';
  return null;
}

/** Split into lines, dropping the single trailing empty element produced
 *  by a terminating newline (so "a\n" counts as one line). */
function splitLines(s: string): string[] {
  const lines = s.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface EditPair {
  readonly oldStr: string;
  readonly newStr: string;
}

/** LCS line diff. Returns the merged line sequence tagged add/del/context. */
function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  // LCS length table.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: a[i]! });
    i++;
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j]! });
    j++;
  }
  return out;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)
    : null;
}

function extractPath(obj: Record<string, unknown>): string | null {
  const raw = obj['file_path'] ?? obj['path'] ?? obj['notebook_path'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

function extractEdits(tool: FileChangeTool, obj: Record<string, unknown>): EditPair[] | null {
  if (tool === 'write') {
    const content = obj['content'];
    if (typeof content !== 'string') return null;
    return [{ oldStr: '', newStr: content }];
  }
  if (tool === 'multiedit') {
    const rawEdits = obj['edits'];
    if (!Array.isArray(rawEdits)) return null;
    const pairs: EditPair[] = [];
    for (const raw of rawEdits) {
      const e = asRecord(raw);
      if (!e) continue;
      const oldStr = typeof e['old_string'] === 'string' ? (e['old_string'] as string) : '';
      const newStr = typeof e['new_string'] === 'string' ? (e['new_string'] as string) : '';
      if (oldStr === '' && newStr === '') continue;
      pairs.push({ oldStr, newStr });
    }
    return pairs.length > 0 ? pairs : null;
  }
  // Edit / NotebookEdit: single old_string/new_string pair.
  const oldStr = typeof obj['old_string'] === 'string' ? (obj['old_string'] as string) : '';
  const newStr = typeof obj['new_string'] === 'string' ? (obj['new_string'] as string) : '';
  if (oldStr === '' && newStr === '') return null;
  return [{ oldStr, newStr }];
}

/** Project a tool invocation to its FileChange, or null when the input
 *  shape isn't a recognised file mutation. */
export function computeFileChange(
  toolName: string,
  input: unknown,
): FileChange | null {
  const tool = fileChangeTool(toolName);
  if (!tool) return null;
  const obj = asRecord(input);
  if (!obj) return null;
  const path = extractPath(obj);
  if (!path) return null;
  const pairs = extractEdits(tool, obj);
  if (!pairs) return null;

  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  for (const pair of pairs) {
    for (const line of diffLines(pair.oldStr, pair.newStr)) {
      if (line.kind === 'add') additions++;
      else if (line.kind === 'del') deletions++;
      lines.push(line);
    }
  }
  return {
    path,
    isNew: tool === 'write' && deletions === 0,
    additions,
    deletions,
    lines,
    hunks: pairs.length,
  };
}

/** Split an absolute path into [projectHint, relativeOrTail] for display.
 *  When `workspacePath` is known and the file sits under it, the project
 *  hint is the workspace folder name and the tail is the workspace-
 *  relative path. Otherwise the two last meaningful segments are used. */
export function displayPathParts(
  absPath: string,
  workspacePath?: string,
): { project: string; relative: string } {
  const norm = absPath.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const segments = norm.split('/').filter((s) => s !== '');
  if (workspacePath) {
    const ws = workspacePath.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    const wsSegs = ws.split('/').filter((s) => s !== '');
    // Prefix match: the file lives inside the workspace. The project hint
    // is the workspace folder name; the tail is the workspace-relative
    // path (what an IDE SCM view shows next to the +/- badges).
    const wsLower = ws.toLowerCase();
    if (wsSegs.length > 0 && norm.toLowerCase().startsWith(wsLower + '/')) {
      const project = wsSegs[wsSegs.length - 1]!;
      const relative = norm.slice(wsLower.length + 1);
      return { project, relative };
    }
  }
  const file = segments[segments.length - 1] ?? norm;
  const parent = segments[segments.length - 2];
  return {
    project: parent ?? '',
    relative: parent ? `${parent}/${file}` : file,
  };
}
