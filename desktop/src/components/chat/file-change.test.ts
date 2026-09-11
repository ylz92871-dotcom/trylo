import { describe, expect, it } from 'vitest';

import {
  computeFileChange,
  displayPathParts,
  fileChangeTool,
} from './file-change';

describe('fileChangeTool', () => {
  it('recognises file-mutating tools case-insensitively', () => {
    expect(fileChangeTool('Edit')).toBe('edit');
    expect(fileChangeTool('multiedit')).toBe('multiedit');
    expect(fileChangeTool('Write')).toBe('write');
    expect(fileChangeTool('NotebookEdit')).toBe('notebookedit');
    expect(fileChangeTool('Bash')).toBeNull();
    expect(fileChangeTool('Read')).toBeNull();
  });
});

describe('computeFileChange', () => {
  it('counts added/removed lines for an Edit hunk', () => {
    const change = computeFileChange('Edit', {
      file_path: 'D:/work/trylo/src/a.ts',
      old_string: 'line1\nline2\nline3',
      new_string: 'line1\nline2 changed\nline3\nline4',
    });
    expect(change).not.toBeNull();
    expect(change!.deletions).toBe(1);
    expect(change!.additions).toBe(2);
    expect(change!.isNew).toBe(false);
    expect(change!.hunks).toBe(1);
    expect(change!.lines.some((l) => l.kind === 'del' && l.text === 'line2')).toBe(true);
    expect(change!.lines.some((l) => l.kind === 'add' && l.text === 'line2 changed')).toBe(true);
    expect(change!.lines.some((l) => l.kind === 'add' && l.text === 'line4')).toBe(true);
  });

  it('treats Write as a new file with pure additions', () => {
    const change = computeFileChange('Write', {
      file_path: '/repo/src/new.ts',
      content: 'a\nb\nc\n',
    });
    expect(change).not.toBeNull();
    expect(change!.isNew).toBe(true);
    expect(change!.additions).toBe(3);
    expect(change!.deletions).toBe(0);
    expect(change!.lines.every((l) => l.kind === 'add')).toBe(true);
  });

  it('aggregates MultiEdit hunks', () => {
    const change = computeFileChange('MultiEdit', {
      file_path: '/repo/src/b.ts',
      edits: [
        { old_string: 'x1', new_string: 'x1\nx2' },
        { old_string: 'y1\ny2', new_string: 'y1 changed' },
      ],
    });
    expect(change).not.toBeNull();
    expect(change!.hunks).toBe(2);
    expect(change!.additions).toBe(2); // x2 + "y1 changed"
    expect(change!.deletions).toBe(2); // y1 + y2
  });

  it('returns null for non-file tools or malformed input', () => {
    expect(computeFileChange('Bash', { command: 'ls' })).toBeNull();
    expect(computeFileChange('Edit', { old_string: 'a', new_string: 'b' })).toBeNull();
    expect(computeFileChange('Edit', null)).toBeNull();
    expect(computeFileChange('Edit', { file_path: '/a.ts' })).toBeNull();
  });
});

describe('displayPathParts', () => {
  it('relativises against the workspace and names the project', () => {
    const parts = displayPathParts('C:/work/demo-ws/desktop/src/a.ts', 'C:/work/demo-ws');
    expect(parts.project).toBe('demo-ws');
    expect(parts.relative).toBe('desktop/src/a.ts');
  });

  it('tolerates backslashes in either path', () => {
    const parts = displayPathParts('C:\\work\\demo-ws\\desktop\\a.ts', 'C:\\work\\demo-ws\\');
    expect(parts.project).toBe('demo-ws');
    expect(parts.relative).toBe('desktop/a.ts');
  });

  it('falls back to the tail segments without a workspace', () => {
    const parts = displayPathParts('/x/y/z/file.ts');
    expect(parts.project).toBe('z');
    expect(parts.relative).toBe('z/file.ts');
  });
});
