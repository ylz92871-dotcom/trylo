// Trylo Desktop — file-change model for IDE-style edit cards.
//
// Projection from file tool requests and optional committed results to:
//   - the changed file path
//   - added / removed line counts (the green "+N" / red "-N" badges)
//   - a line-level diff for the expandable body
//
// Patch parsing is linear. Legacy old/new snippets use a line LCS;
// writes without a before image remain content, never invented additions.

import type { ToolResultContent } from '../../tooling/tool-result-content';
import { fileMutationFacts, type FileMutationFact } from '../../tooling/file-mutation-facts';
import { changeFromLines, codexPatchChanges, contentChange, unifiedPatchChange } from './file-change-patch';
import type { DiffLine, FileChange, FileChangeTool } from './file-change-types';
export type { DiffLine, FileChange, FileChangeTool } from './file-change-types';

/** Normalise the raw tool name to a supported file-change tool, or null
 *  when the invocation doesn't mutate a single file. */
export function fileChangeTool(tool: string): FileChangeTool | null {
  const t = String(tool || '').toLowerCase();
  if (t === 'edit' || t === 'edit_file') return 'edit';
  if (t === 'multiedit') return 'multiedit';
  if (t === 'write' || t === 'write_file') return 'write';
  if (t === 'apply_patch' || t === 'applypatch') return 'patch';
  if (t === 'notebookedit' || t === 'notebook_edit') return 'notebookedit';
  return null;
}

/** Split into lines, dropping the single trailing empty element produced
 *  by a terminating newline (so "a\n" counts as one line). */
function splitLines(s: string): string[] {
  const lines = s.replace(/\r\n/g, '\n').split('\n');
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
      out.push({ kind: 'context', text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]!, oldNo: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j]!, newNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: a[i]!, oldNo: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j]!, newNo: j + 1 });
    j++;
  }
  return out;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function extractPath(obj: Record<string, unknown>): string | null {
  const raw = obj['file_path'] ?? obj['path'] ?? obj['notebook_path'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

function extractEdits(tool: FileChangeTool, obj: Record<string, unknown>): EditPair[] | null {
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

// The LCS in diffLines is O(n·m) over the file's lines, and computeFileChange
// runs on every render of every visible file-change row (Message routes with
// it, FileChangeCard renders with it) plus once per mount while scrolling a
// virtualized list. events.ts keeps the `input` object identity stable across
// status updates (it spreads the old message), so memoizing on input identity
// turns repeats into lookups without any per-message bookkeeping.
const fileChangeCache = new WeakMap<object, { tool: FileChangeTool; content: unknown; changes: readonly FileChange[] }>();

/** Project a tool invocation to its FileChange, or null when the input
 *  shape isn't a recognised file mutation. */
export function computeFileChange(
  toolName: string,
  input: unknown,
  content?: readonly ToolResultContent[],
): FileChange | null {
  return computeFileChanges(toolName, input, content)[0] ?? null;
}

export function computeFileChanges(toolName: string, input: unknown, content?: readonly ToolResultContent[]): readonly FileChange[] {
  const tool = fileChangeTool(toolName);
  if (!tool) return fileMutationFacts(content)?.map(fact => committedChange(fact, [])) ?? [];
  const obj = asRecord(input) ?? {};
  const cached = fileChangeCache.get(obj);
  if (cached && cached.tool === tool && cached.content === content) return cached.changes;
  const requested = requestedChanges(tool, obj);
  const facts = fileMutationFacts(content);
  const changes = facts?.length ? facts.map(fact => committedChange(fact, requested)) : requested;
  fileChangeCache.set(obj, { tool, content, changes });
  return changes;
}

function requestedChanges(
  tool: FileChangeTool,
  obj: Record<string, unknown>,
): readonly FileChange[] {
  if (tool === 'patch') return typeof obj.patch === 'string' ? codexPatchChanges(obj.patch) : [];
  const path = extractPath(obj);
  if (!path) return [];
  if (tool === 'edit' && typeof obj.patch === 'string') {
    const change = unifiedPatchChange(path, obj.patch);
    return change ? [change] : [];
  }
  if (tool === 'write') return typeof obj.content === 'string'
    ? [contentChange(path, obj.content, '缺少修改前快照，仅展示写入内容，无法计算增删。')] : [];
  if (tool === 'notebookedit' && typeof obj.new_source === 'string') {
    const note = obj.edit_mode === 'delete' ? '删除单元；缺少修改前单元快照，无法展示删除 diff。'
      : '单元写入内容；缺少修改前单元快照，无法计算文件 diff。';
    return [contentChange(path, obj.new_source, note, 'cell')];
  }
  const pairs = extractEdits(tool, obj);
  if (!pairs) return [];

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
  return [changeFromLines(path, lines, { additions, deletions, hunks: pairs.length })];
}

function committedChange(fact: FileMutationFact, requested: readonly FileChange[]): FileChange {
  const samePath = (path: string) => path.replace(/\\/g, '/') === fact.path.replace(/\\/g, '/');
  const proposed = requested.find(change => samePath(change.path));
  const preview = fact.kind !== 'overwritten' && fact.preview ? unifiedPatchChange(fact.path, fact.preview, 'result') : null;
  if (preview) return { ...preview, operation: fact.kind, isNew: fact.kind === 'created', fromPath: fact.from, truncated: fact.truncated || preview.truncated };
  if (fact.kind === 'created' && proposed?.basis === 'content') {
    return changeFromLines(fact.path, proposed.lines.map(line => ({ ...line, kind: 'add' })), {
      operation: 'created', isNew: true, basis: 'result', lineNumbers: 'file', truncated: fact.truncated,
    });
  }
  if (fact.kind === 'overwritten' && proposed) {
    return contentChange(fact.path, proposed.lines.filter(line => line.kind !== 'del' && line.kind !== 'hunk').map(line => line.text).join('\n'),
      '已覆盖文件；缺少修改前快照，仅展示写入内容，无法计算增删。', 'overwritten');
  }
  if (proposed) return { ...proposed, operation: fact.kind, isNew: fact.kind === 'created', fromPath: fact.from ?? proposed.fromPath };
  return contentChange(fact.path, '', '工具已报告文件变更，但缺少前后内容，无法展示 diff。', fact.kind);
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
