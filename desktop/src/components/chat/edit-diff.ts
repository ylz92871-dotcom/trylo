// Trylo Desktop — line-level diff for Code-mode Edit/Write tools.
//
// The chat stream renders every Edit/Write tool call as an IDE-style
// changelist entry: file path + green `+N` / red `−M` stats, with an
// expandable unified diff. This module is the pure core — it turns the
// tool input's old_string/new_string into LCS-based diff rows and stats.
// No React here so the algorithm is trivially unit-testable.

export type DiffRowType = 'ctx' | 'add' | 'del';

export interface DiffRow {
  readonly type: DiffRowType;
  readonly text: string;
  /** 1-based line number in the OLD file (undefined for added lines). */
  readonly oldNo?: number;
  /** 1-based line number in the NEW file (undefined for deleted lines). */
  readonly newNo?: number;
}

export interface EditDiff {
  readonly rows: readonly DiffRow[];
  readonly additions: number;
  readonly deletions: number;
}

/** Split into lines the way the Edit tool sees them. A trailing newline
 *  does NOT produce a phantom empty last line. */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS backtrack over two line arrays → unified diff rows with line
 *  numbers. Equal lines are context; lines only on the right are
 *  additions; lines only on the left are deletions. */
export function lineDiff(oldText: string, newText: string): EditDiff {
  const a = toLines(oldText);
  const b = toLines(newText);
  const n = a.length;
  const m = b.length;

  // Standard LCS length table. Edit snippets are small (a hunk, never a
  // whole file), so O(n*m) time and memory are fine.
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: 'del', text: a[i]!, oldNo: i + 1 });
      deletions++;
      i++;
    } else {
      rows.push({ type: 'add', text: b[j]!, newNo: j + 1 });
      additions++;
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: 'del', text: a[i]!, oldNo: i + 1 });
    deletions++;
    i++;
  }
  while (j < m) {
    rows.push({ type: 'add', text: b[j]!, newNo: j + 1 });
    additions++;
    j++;
  }

  return { rows, additions, deletions };
}

/** File-editing tools whose input describes a concrete file change, in
 *  the PascalCase vocabulary the CLI emits (plus lowercase tolerance for
 *  old sessions / other runtimes). */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'notebookedit',
  'multiedit',
]);

export function isFileEditTool(tool: string): boolean {
  return FILE_EDIT_TOOLS.has(tool.toLowerCase());
}

/** Extract (filePath, oldText, newText) from a tool-call input record.
 *  Returns null when the input is not a recognisable file edit.
 *  - Edit:  old_string → new_string
 *  - Write: content is the whole new file (oldText = '')
 *  - MultiEdit: best-effort join of its edits' strings */
export interface FileEditInput {
  readonly filePath: string;
  readonly oldText: string;
  readonly newText: string;
}

export function parseFileEditInput(
  tool: string,
  input: unknown,
): FileEditInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  const filePath =
    typeof obj['file_path'] === 'string'
      ? (obj['file_path'] as string)
      : typeof obj['path'] === 'string'
        ? (obj['path'] as string)
        : '';
  if (filePath === '') return null;

  const t = tool.toLowerCase();
  if (t === 'write') {
    const content = typeof obj['content'] === 'string' ? (obj['content'] as string) : '';
    return { filePath, oldText: '', newText: content };
  }
  if (t === 'multiedit') {
    const edits = Array.isArray(obj['edits']) ? (obj['edits'] as unknown[]) : [];
    let oldText = '';
    let newText = '';
    for (const e of edits) {
      if (typeof e !== 'object' || e === null) continue;
      const rec = e as Record<string, unknown>;
      const o = typeof rec['old_string'] === 'string' ? (rec['old_string'] as string) : '';
      const n = typeof rec['new_string'] === 'string' ? (rec['new_string'] as string) : '';
      oldText += o;
      newText += n;
    }
    return { filePath, oldText, newText };
  }
  // Edit / NotebookEdit / default.
  const oldText =
    typeof obj['old_string'] === 'string' ? (obj['old_string'] as string) : '';
  const newText =
    typeof obj['new_string'] === 'string' ? (obj['new_string'] as string) : '';
  if (t === 'edit' && oldText === '' && newText === '') return null;
  return { filePath, oldText, newText };
}
