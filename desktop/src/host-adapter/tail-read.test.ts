// Trylo Desktop — tail-read unit tests. See
// v1.15-handoff §3.1.

import { describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailRead, type TailReadDeps } from './tail-read';

function makeDeps(initial: string): {
  deps: TailReadDeps;
  set: (next: string) => void;
} {
  let current = initial;
  const deps: TailReadDeps = {
    readFile: async () => current,
    stat: async () => ({ size: current.length }),
  };
  return {
    deps,
    set: (next: string) => {
      current = next;
    },
  };
}

describe('tailRead', () => {
  it('returns no events on an empty file', async () => {
    const { deps } = makeDeps('');
    const r = await tailRead('x', 0, '', deps);
    expect(r.events).toEqual([]);
    expect(r.pos).toBe(0);
    expect(r.leftover).toBe('');
  });

  it('parses a single complete line', async () => {
    const { deps } = makeDeps('{"a":1}\n');
    const r = await tailRead('x', 0, '', deps);
    expect(r.events).toEqual([{ a: 1 }]);
    expect(r.leftover).toBe('');
  });

  it('parses multiple lines and skips empty ones', async () => {
    const { deps } = makeDeps('{"a":1}\n\n{"b":2}\n');
    const r = await tailRead('x', 0, '', deps);
    expect(r.events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('holds back a partial trailing line as leftover', async () => {
    const { deps } = makeDeps('{"a":1}\n{"b"');
    const r = await tailRead('x', 0, '', deps);
    expect(r.events).toEqual([{ a: 1 }]);
    expect(r.leftover).toBe('{"b"');
  });

  it('parses the leftover on the next call', async () => {
    const { deps, set } = makeDeps('{"a":1}\n{"b"');
    const r1 = await tailRead('x', 0, '', deps);
    expect(r1.events).toEqual([{ a: 1 }]);
    set('{"a":1}\n{"b":2}\n');
    const r2 = await tailRead('x', r1.pos, r1.leftover, deps);
    expect(r2.events).toEqual([{ b: 2 }]);
  });

  it('skips malformed lines without throwing', async () => {
    const { deps } = makeDeps('{"a":1}\nnot-json\n{"b":2}\n');
    const r = await tailRead('x', 0, '', deps);
    expect(r.events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('resets when the file shrinks below the current pos (truncation)', async () => {
    const { deps, set } = makeDeps('{"a":1}\n{"b":2}\n'); // 16 chars
    const r1 = await tailRead('x', 0, '', deps);
    expect(r1.events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r1.pos).toBe(16);
    expect(r1.leftover).toBe('');
    // Simulate a new session overwriting the file (smaller).
    set('{"c":3}\n'); // 8 chars — smaller than the prior pos
    const r2 = await tailRead('x', r1.pos, r1.leftover, deps);
    expect(r2.events).toEqual([{ c: 3 }]);
  });

  it('returns no events when stat fails', async () => {
    const deps: TailReadDeps = {
      readFile: async () => '',
      stat: async () => null,
    };
    const r = await tailRead('x', 0, '', deps);
    expect(r.events).toEqual([]);
    expect(r.totalSize).toBeNull();
  });

  it('never replays old events when the file grows (compaction-flood guard)', async () => {
    // THE regression: the old implementation returned the FULL file on
    // every growth tick, and the chat reducer appends one pill per
    // `compact` event — so a long run stacked dozens of identical
    // "context compacted" cards. Tools self-heal by id; compaction
    // does not. Only the delta may come out.
    const { deps, set } = makeDeps('{"a":1}\n');
    const r1 = await tailRead('x', 0, '', deps);
    expect(r1.events).toEqual([{ a: 1 }]);
    set('{"a":1}\n{"b":2}\n');
    const r2 = await tailRead('x', r1.pos, r1.leftover, deps);
    expect(r2.events).toEqual([{ b: 2 }]);
    // A third tick with no growth is silent.
    const r3 = await tailRead('x', r2.pos, r2.leftover, deps);
    expect(r3.events).toEqual([]);
  });

  it('delivers deltas across real file appends with multibyte content', async () => {
    // End-to-end through real fs I/O: stat sizes are UTF-8 BYTES while
    // `pos` counts JS chars. A Chinese log line must not shift the
    // delta window (which would replay or drop events).
    const dir = mkdtempSync(join(tmpdir(), 'trylo-tail-'));
    const file = join(dir, 'events.jsonl');
    const line1 = JSON.stringify({ type: 'compact', note: '四层板教学', n: 1 }) + '\n';
    const line2 = JSON.stringify({ type: 'tool_result', note: '执行完成', n: 2 }) + '\n';
    writeFileSync(file, line1, 'utf8');
    const realDeps: TailReadDeps = {
      readFile: (p) => Promise.resolve(readFileSync(p, 'utf8')),
      stat: (p) => Promise.resolve({ size: statSync(p).size }),
    };
    const r1 = await tailRead(file, 0, '', realDeps);
    expect(r1.events).toHaveLength(1);
    appendFileSync(file, line2, 'utf8');
    const r2 = await tailRead(file, r1.pos, r1.leftover, realDeps);
    // Exactly the appended line — the Chinese first line is NOT replayed.
    expect(r2.events).toEqual([{ type: 'tool_result', note: '执行完成', n: 2 }]);
    rmSync(dir, { recursive: true, force: true });
  });
});
