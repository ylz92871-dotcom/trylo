// Trylo Desktop — EditorBridgeImpl unit tests. See ARCHITECTURE.md
// §2.5 + §2.3.1.
//
// Lock down the state-machine behavior we depend on:
//   - Initial load populates buffer = load.content.
//   - User edits (setBuffer) flip dirty.
//   - External change while clean → silent auto-reload.
//   - External change while dirty → setConflict('modified').
//   - External change ('deleted') while clean → setLoad('deleted').
//   - External change ('deleted') while dirty → setConflict('deleted').
//   - acceptExternal() (called by App.tsx after re-reading)
//     re-aligns buffer = load.content, dirty becomes false.
//   - keepMine() writes buffer to disk and clears dirty.
//
// The tests use a stub FS so they run in plain Node — no Tauri
// runtime needed.

import { describe, expect, it } from 'vitest';
import { EditorBridgeImpl, type EditorBridgeFs } from './editor-bridge-impl';
import type { FileStat } from './types';

const fakeStat: FileStat = {
  path: '/x',
  size: 0,
  modifiedMs: 0,
  isDirectory: false,
  isFile: true,
  isSymlink: false,
};

function makeFs(opts: {
  initialContent: string;
  size?: number;
} = { initialContent: 'hello\n' }): EditorBridgeFs & { writes: { path: string; content: string }[] } {
  const writes: { path: string; content: string }[] = [];
  return {
    writes,
    readFile: async () => opts.initialContent,
    writeFile: async (path, content) => {
      writes.push({ path, content });
    },
    statFile: async () => ({ ...fakeStat, size: opts.size ?? opts.initialContent.length }),
  };
}

describe('EditorBridgeImpl — initial load', () => {
  it('populates load + buffer on construction', async () => {
    const fs = makeFs({ initialContent: 'a\nb\n' });
    const b = new EditorBridgeImpl({ path: '/x', fs });
    // Wait for the loadInitial microtask to resolve.
    await new Promise((r) => setTimeout(r, 0));
    const load = b.getLoad();
    expect(load.kind).toBe('ready');
    if (load.kind !== 'ready') return;
    expect(load.content).toBe('a\nb\n');
    expect(b.getBuffer()).toBe('a\nb\n');
    expect(b.isDirty()).toBe(false);
  });

  it('reports error on read failure', async () => {
    const fs: EditorBridgeFs = {
      readFile: async () => { throw new Error('nope'); },
      writeFile: async () => {},
      statFile: async () => fakeStat,
    };
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    const load = b.getLoad();
    expect(load.kind).toBe('error');
    if (load.kind !== 'error') return;
    expect(load.message).toBe('nope');
  });
});

describe('EditorBridgeImpl — dirty tracking', () => {
  it('user edit flips dirty', async () => {
    const fs = makeFs({ initialContent: 'a' });
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    expect(b.isDirty()).toBe(false);
    b.setBuffer('a + edit');
    expect(b.isDirty()).toBe(true);
  });

  it('onBufferChange listeners fire on edit', async () => {
    const fs = makeFs({ initialContent: 'a' });
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    const seen: string[] = [];
    const unsubscribe = b.onBufferChange((v) => seen.push(v));
    b.setBuffer('b');
    b.setBuffer('c');
    expect(seen).toEqual(['b', 'c']);
    unsubscribe();
    b.setBuffer('d');
    expect(seen).toEqual(['b', 'c']);
  });
});

describe('EditorBridgeImpl — external events', () => {
  it('clean + modified: silent auto-reload', async () => {
    let content = 'v1';
    const fs: EditorBridgeFs = {
      readFile: async () => content,
      writeFile: async () => {},
      statFile: async () => fakeStat,
    };
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    expect(b.getBuffer()).toBe('v1');
    content = 'v2';
    await b.onExternalEvent({ kind: 'modified', path: '/x' });
    const load = b.getLoad();
    expect(load.kind).toBe('ready');
    if (load.kind !== 'ready') return;
    expect(load.content).toBe('v2');
    expect(b.getBuffer()).toBe('v2');
    expect(b.isDirty()).toBe(false);
  });

  it('dirty + modified: fires conflict with external content', async () => {
    let content = 'v1';
    const fs: EditorBridgeFs = {
      readFile: async () => content,
      writeFile: async () => {},
      statFile: async () => fakeStat,
    };
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    b.setBuffer('user edit on v1');
    expect(b.isDirty()).toBe(true);
    content = 'v2';
    const conflicts: unknown[] = [];
    b.onConflict((e) => conflicts.push(e));
    await b.onExternalEvent({ kind: 'modified', path: '/x' });
    // Buffer is NOT clobbered by an external change while dirty.
    expect(b.getBuffer()).toBe('user edit on v1');
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0] as { kind: string; externalContent: string };
    expect(c.kind).toBe('modified');
    expect(c.externalContent).toBe('v2');
  });

  it('clean + deleted: load becomes "deleted"', async () => {
    const fs = makeFs({ initialContent: 'a' });
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    await b.onExternalEvent({ kind: 'deleted', path: '/x' });
    expect(b.getLoad().kind).toBe('deleted');
  });

  it('dirty + deleted: fires conflict, buffer preserved', async () => {
    const fs = makeFs({ initialContent: 'a' });
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    b.setBuffer('unsaved');
    const conflicts: unknown[] = [];
    b.onConflict((e) => conflicts.push(e));
    await b.onExternalEvent({ kind: 'deleted', path: '/x' });
    expect(b.getBuffer()).toBe('unsaved');
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0] as { kind: string };
    expect(c.kind).toBe('deleted');
  });
});

describe('EditorBridgeImpl — save / reload', () => {
  it('keepMine writes buffer to disk and clears dirty', async () => {
    const fs = makeFs({ initialContent: 'a' });
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    b.setBuffer('a + edit');
    await b.keepMine();
    expect(fs.writes).toEqual([{ path: '/x', content: 'a + edit' }]);
    expect(b.isDirty()).toBe(false);
  });

  it('reload re-reads the file', async () => {
    let content = 'v1';
    const fs: EditorBridgeFs = {
      readFile: async () => content,
      writeFile: async () => {},
      statFile: async () => fakeStat,
    };
    const b = new EditorBridgeImpl({ path: '/x', fs });
    await new Promise((r) => setTimeout(r, 0));
    b.setBuffer('user edit');
    content = 'v2 from disk';
    await b.reload();
    const load = b.getLoad();
    expect(load.kind).toBe('ready');
    if (load.kind !== 'ready') return;
    expect(load.content).toBe('v2 from disk');
    expect(b.getBuffer()).toBe('v2 from disk');
    expect(b.isDirty()).toBe(false);
  });
});
