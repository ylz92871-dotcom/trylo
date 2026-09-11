// Trylo Desktop — events reducer test.
//
// Uses the real trylo-complex fixture (hand-crafted 42-event
// run with 6 turns, sub-agents, compaction). The reducer is a
// pure function: events in, ChatMessage list out. The test
// asserts that 42 events produce the expected set of
// rendered messages, in order.

import { describe, expect, it, vi } from 'vitest';
import { applyEvents } from './events';
import { fixture, fixtureSummary } from './__fixtures__/trylo-complex';

describe('events reducer (trylo-complex fixture)', () => {
  it('summary stats match the fixture shape', () => {
    expect(fixtureSummary.totalEvents).toBe(42);
    expect(fixtureSummary.turnCount).toBe(6);
    expect(fixtureSummary.toolUseCount).toBe(5);
    expect(fixtureSummary.toolResultCount).toBe(5);
    expect(fixtureSummary.thinkingCount).toBe(6);
    expect(fixtureSummary.subagentCount).toBe(2);
    expect(fixtureSummary.compactionCount).toBe(1);
  });

  it('handles all 42 events without throwing', () => {
    expect(() => applyEvents([], fixture)).not.toThrow();
  });

  it('produces a ChatMessage list with the expected kinds', () => {
    const out = applyEvents([], fixture);
    // Lifecycle bookkeeping is intentionally hidden. The
    // rendered output is 6 turn + 6 think + 5 text + 5 tool
    // + 1 compaction pill = 23 messages.
    expect(out.length).toBeGreaterThan(20);

    const kinds = out.map((m) => m.kind);
    // Exactly 6 turn dividers (one per turn_start)
    expect(kinds.filter((k) => k === 'turn').length).toBe(6);
    // 6 thinking messages (one per thinking event)
    expect(kinds.filter((k) => k === 'thinking').length).toBe(6);
    // 5 tool messages (Read x3, Grep x2)
    expect(kinds.filter((k) => k === 'tool').length).toBe(5);
    // 1 compaction pill
    expect(kinds.filter((k) => k === 'compaction').length).toBe(1);
    // Five text bubbles: turn 6 has no intervening tool,
    // so its final text updates turn 5's still-open bubble.
    expect(kinds.filter((k) => k === 'text').length).toBe(5);
    expect(kinds.filter((k) => k === 'notice').length).toBe(0);
  });

  it('turn dividers carry the turn number', () => {
    const out = applyEvents([], fixture);
    const turns = out
      .filter((m) => m.kind === 'turn')
      .map((m) => (m as { turn: number }).turn);
    expect(turns).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('thinking messages use the summary field', () => {
    const out = applyEvents([], fixture);
    const thinkings = out
      .filter((m) => m.kind === 'thinking')
      .map((m) => (m as { summary: string }).summary);
    expect(thinkings[0]).toMatch(/brand/);
    expect(thinkings[1]).toMatch(/tokens/);
    expect(thinkings[2]).toMatch(/Trylo Gold/);
    expect(thinkings[3]).toMatch(/compaction/);
    expect(thinkings[4]).toMatch(/hardcoded/);
  });

  it('tool messages pair with their results (matched by tool id)', () => {
    const out = applyEvents([], fixture);
    const tools = out.filter((m) => m.kind === 'tool') as Array<{
      tool: string; status: string; input?: unknown; outputText?: string;
    }>;
    // tu-1 = Grep → output mentions brand
    const grep1 = tools.find((t) => t.tool === 'Grep');
    expect(grep1).toBeDefined();
    expect(grep1?.status).toBe('done');
    expect(grep1?.outputText).toContain('DBC97F');
    // tu-2 = Read → file_path
    const read2 = tools.find((t) => t.input && JSON.stringify(t.input).includes('tokens.css'));
    expect(read2).toBeDefined();
    expect(read2?.status).toBe('done');
  });

  it('stamps phaseId on thinking and phaseId + toolCallId on tools (spec §5.2)', () => {
    const out = applyEvents([], fixture);
    for (const m of out) {
      if (m.kind === 'thinking') {
        // Every phase carries a stable phaseId.
        expect(typeof m.phaseId === 'string' && m.phaseId.length > 0).toBe(true);
      } else if (m.kind === 'tool') {
        // Every tool carries the stable invocation id (the
        // Anthropic tool_use block id) and a phaseId.
        expect(m.toolCallId).toMatch(/^tu-\d+$/);
        expect(typeof m.phaseId === 'string' && m.phaseId.length > 0).toBe(true);
      }
    }
    // A tool belongs to the phase of the thinking directly
    // before it — the walk below re-derives the Code phase
    // rule from the output and checks the ids agree.
    let currentPhase: string | undefined;
    for (const m of out) {
      if (m.kind === 'thinking') {
        currentPhase = m.phaseId;
        continue;
      }
      if (m.kind === 'tool') {
        expect(m.phaseId).toBe(currentPhase);
      }
    }
  });

  it('compaction pill shows 180k→40k', () => {
    const out = applyEvents([], fixture);
    const pill = out.find((m) => m.kind === 'compaction');
    expect(pill).toBeDefined();
    if (pill && pill.kind === 'compaction') {
      expect(pill.tokensBefore).toBe(184000);
      expect(pill.tokensAfter).toBe(42000);
    }
  });

  it('events appended incrementally (streaming) match the full batch', () => {
    // Process in chunks of 5 to simulate streaming.
    let acc: ReturnType<typeof applyEvents> = [];
    for (let i = 0; i < fixture.length; i += 5) {
      acc = applyEvents(acc, fixture.slice(i, i + 5));
    }
    const full = applyEvents([], fixture);
    expect(acc.length).toBe(full.length);
  });

  it('does not flash an unreadable first-token thinking fragment', () => {
    const tiny = applyEvents([], [{
      type: 'thinking', seq: 1, ts: 1, turn: 1,
      summary: '先看', preview: '先看', fullLength: 2, partial: true,
    }]);
    expect(tiny).toEqual([]);

    const readable = applyEvents(tiny, [{
      type: 'thinking', seq: 2, ts: 2, turn: 1,
      summary: '先看看当前工作区有哪些文件',
      preview: '先看看当前工作区有哪些文件，再决定下一步怎么修改。',
      fullLength: 24,
      partial: true,
    }]);
    expect(readable.some((message) => message.kind === 'thinking')).toBe(true);
  });

  it('§8.1: managed-work subagent events are NOT projected by the generic reducer', () => {
    // P3-B2: the ManagedWorkCoordinator owns managed-work cards (it binds
    // the session, subscribes to workd broadcasts and projects updates).
    // Handling them here would create a duplicate running card the
    // coordinator cannot update — the reducer must pass them through.
    const out = applyEvents([], [
      { type: 'subagent', kind: 'spawn', id: 'sub-9', agentType: 'managed-work', prompt: 'do work', seq: 1, ts: 1 },
      { type: 'subagent', kind: 'end', id: 'sub-9', result: 'receipt', durationMs: 100, seq: 2, ts: 2 },
    ] as never);
    expect(out).toHaveLength(0);
  });

  it('five Team seats are not projected into Person chat', () => {
    const out = applyEvents([], [
      { type: 'subagent', kind: 'spawn', id: 'seat-w', agentType: 'worker', prompt: 'write', seq: 1, ts: 1 },
      { type: 'subagent', kind: 'end', id: 'seat-w', agentType: 'worker', result: 'ok', durationMs: 10, seq: 2, ts: 2 },
      { type: 'subagent', kind: 'spawn', id: 'seat-r', agentType: 'reviewer', prompt: 'review', seq: 3, ts: 3 },
    ] as never);
    expect(out).toHaveLength(0);
  });

  it('§8.1: a non-managed subagent spawn appends a running card and end flips it to done', () => {
    const out = applyEvents([], [
      { type: 'subagent', kind: 'spawn', id: 'sub-9', agentType: 'Explore', prompt: 'do work', seq: 1, ts: 1 },
      { type: 'subagent', kind: 'end', id: 'sub-9', result: 'receipt', durationMs: 100, seq: 2, ts: 2 },
    ] as never);
    expect(out).toHaveLength(1);
    const m = out[0] as { kind: string; status: string; agentType: string; result?: string };
    expect(m.kind).toBe('subagent');
    expect(m.status).toBe('done');
    expect(m.agentType).toBe('Explore');
    expect(m.result).toBe('receipt');
  });

  it('§8.1: subagent end without a matching running spawn is a no-op', () => {
    const out = applyEvents([], [
      { type: 'subagent', kind: 'end', id: 'missing', result: 'x', seq: 1, ts: 1 },
    ] as never);
    expect(out).toHaveLength(0);
  });

  it('§8.1: two spawns produce two distinct running cards', () => {
    const out = applyEvents([], [
      { type: 'subagent', kind: 'spawn', id: 'sub-a', agentType: 'A', seq: 1, ts: 1 },
      { type: 'subagent', kind: 'spawn', id: 'sub-b', agentType: 'B', seq: 2, ts: 2 },
    ] as never);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.kind === 'subagent' && m.status === 'running')).toBe(true);
  });
});

// ── PR-4 (spec §7 / §14.3): structured tool results & pairing ─────────

describe('events reducer: structured tool results (PR-4)', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const REF = {
    id: 'bin-1', storage: 'ephemeral-tool-cache' as const,
    path: 'C:/appdata/tool-cache/aa/aa11.png', mimeType: 'image/png',
    size: 100, sha256: 'a'.repeat(64),
  };

  function runToolTurn(events: Parameters<typeof applyEvents>[1]) {
    return applyEvents([], [
      { type: 'tool_use', seq: 1, ts: 1, turn: 1, id: 'toolu_1', tool: 'mcp__trylo-browser__browser_take_screenshot', input: {} },
      ...events,
    ]);
  }

  it('stores resolved content blocks and the text summary on the tool card', () => {
    const out = runToolTurn([
      { type: 'tool_result', seq: 2, ts: 2, turn: 1, id: 'toolu_1', tool: '', ok: true, output: 'shot', durationMs: 10, content: [{ type: 'text', text: 'shot' }, { type: 'image', ref: REF }] },
    ]);
    const card = out.find((m): m is Extract<typeof m, { kind: 'tool' }> => m.kind === 'tool')!;
    expect(card.status).toBe('done');
    expect(card.outputText).toBe('shot');
    expect(card.outputContent).toEqual([{ type: 'text', text: 'shot' }, { type: 'image', ref: REF }]);
  });

  it('§15.2 breaker: a raw base64 block leaking into an event is stripped, never persisted', () => {
    const out = runToolTurn([
      { type: 'tool_result', seq: 2, ts: 2, turn: 1, id: 'toolu_1', tool: '', ok: true, output: '', durationMs: 10, content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
    ]);
    const card = out.find((m): m is Extract<typeof m, { kind: 'tool' }> => m.kind === 'tool')!;
    expect(card.outputContent).toEqual([{ type: 'text', text: '[image not cached — dropped]' }]);
    expect(JSON.stringify(card)).not.toContain('iVBOR');
  });

  it('pairs results by toolCallId when two tools ran in parallel (§14.3 串配修复)', () => {
    const out = applyEvents([], [
      { type: 'tool_use', seq: 1, ts: 1, turn: 1, id: 'toolu_A', tool: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', seq: 2, ts: 2, turn: 1, id: 'toolu_B', tool: 'Read', input: { file_path: 'b.ts' } },
      { type: 'tool_result', seq: 3, ts: 3, turn: 1, id: 'toolu_B', tool: '', ok: true, output: 'B result', durationMs: 5 },
      { type: 'tool_result', seq: 4, ts: 4, turn: 1, id: 'toolu_A', tool: '', ok: true, output: 'A result', durationMs: 5 },
    ]);
    const cards = out.filter((m): m is Extract<typeof m, { kind: 'tool' }> => m.kind === 'tool');
    const a = cards.find((c) => c.toolCallId === 'toolu_A')!;
    const b = cards.find((c) => c.toolCallId === 'toolu_B')!;
    expect(a.outputText).toBe('A result');
    expect(b.outputText).toBe('B result');
  });

  it('an unmatched non-empty result id is DROPPED, not dumped into a random running card', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = applyEvents([], [
        { type: 'tool_use', seq: 1, ts: 1, turn: 1, id: 'toolu_A', tool: 'Read', input: {} },
        { type: 'tool_use', seq: 2, ts: 2, turn: 1, id: 'toolu_B', tool: 'Read', input: {} },
        { type: 'tool_result', seq: 3, ts: 3, turn: 1, id: 'toolu_X', tool: '', ok: true, output: '??', durationMs: 5 },
      ]);
      const cards = out.filter((m): m is Extract<typeof m, { kind: 'tool' }> => m.kind === 'tool');
      expect(cards.every((c) => c.status === 'running')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('an id-less result still lands when exactly ONE tool is running (legacy raw stream)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = applyEvents([], [
        { type: 'tool_use', seq: 1, ts: 1, turn: 1, id: 'toolu_A', tool: 'Bash', input: {} },
        { type: 'tool_result', seq: 2, ts: 2, turn: 1, id: '', tool: '', ok: true, output: 'serial output', durationMs: 5 },
      ]);
      const card = out.find((m): m is Extract<typeof m, { kind: 'tool' }> => m.kind === 'tool')!;
      expect(card.status).toBe('done');
      expect(card.outputText).toBe('serial output');
    } finally {
      warn.mockRestore();
    }
  });

  it('an id-less result with TWO running tools is dropped (串配不可判定)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = applyEvents([], [
        { type: 'tool_use', seq: 1, ts: 1, turn: 1, id: 'toolu_A', tool: 'Bash', input: {} },
        { type: 'tool_use', seq: 2, ts: 2, turn: 1, id: 'toolu_B', tool: 'Bash', input: {} },
        { type: 'tool_result', seq: 3, ts: 3, turn: 1, id: '', tool: '', ok: true, output: '??', durationMs: 5 },
      ]);
      const cards = out.filter((m): m is Extract<typeof m, { kind: 'tool' }> => m.kind === 'tool');
      expect(cards.every((c) => c.status === 'running')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips nested tools whose parent is a Team seat (no Person subagent card)', () => {
    const out = applyEvents([], [
      { type: 'tool_use', seq: 1, ts: 1, turn: 1, id: 'tu-nested', tool: 'Edit', input: { file_path: 'a.ts' }, parentId: 'seat-w' },
      { type: 'tool_result', seq: 2, ts: 2, turn: 1, id: 'tu-nested', tool: 'Edit', ok: true, output: 'ok', durationMs: 3, parentId: 'seat-w' },
    ]);
    expect(out.filter((m) => m.kind === 'tool')).toEqual([]);
  });

  it('keeps nested tools when the parent is a Person-visible subagent (Explore)', () => {
    const out = applyEvents([], [
      { type: 'subagent', seq: 1, ts: 1, kind: 'spawn', id: 'sub-1', agentType: 'Explore', prompt: 'scan' },
      { type: 'tool_use', seq: 2, ts: 2, turn: 1, id: 'tu-nested', tool: 'Grep', input: { pattern: 'x' }, parentId: 'sub-1' },
    ]);
    expect(out.some((m) => m.kind === 'tool' && (m as { tool: string }).tool === 'Grep')).toBe(true);
  });
});
