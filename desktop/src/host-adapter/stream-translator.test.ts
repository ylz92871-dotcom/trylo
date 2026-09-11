// PR-4 (spec §7 / PR-0 contract 4): the stream translator must preserve
// MCP rich content in tool_result events — the PR-0 confirmed gap A was
// that only `text` blocks were joined and image/resource blocks were
// dropped (stream-translator.ts:342-372 pre-PR-4).
//
// `docs/fixtures/tool-extension/pr4-rich-result.ndjson` records the exact
// shapes these tests feed (hand-built from the pinned CLI's
// `transformResultContent`; the real-model fixture is still pending and
// will be appended to the same file).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamTranslator } from './stream-translator';
import type { ToolResultEvent } from './loop-events';
import { materializeToolResultEvents } from '../tooling/tool-result-store';
import type { ToolResultStore } from '../tooling/tool-result-store';

const SAMPLE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function feedRaw(lines: unknown[]): ToolResultEvent[] {
  const translator = new StreamTranslator();
  const out: ToolResultEvent[] = [];
  for (const line of lines) {
    for (const ev of translator.feed(JSON.stringify(line))) {
      if (ev.type === 'tool_result') out.push(ev);
    }
  }
  return out;
}

/** feedRaw + first-result convenience (tests always expect >=1 result). */
function firstRaw(lines: unknown[]): ToolResultEvent {
  const out = feedRaw(lines);
  expect(out.length).toBeGreaterThanOrEqual(1);
  return out[0]!;
}

function userToolResult(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content, ...extra }],
    },
  };
}

describe('stream-translator: structured tool_result content (PR-4, 缺口 A)', () => {
  it('keeps text blocks in both output and content', () => {
    const e = firstRaw([userToolResult([{ type: 'text', text: 'all good' }])]);
    expect(e.output).toBe('all good');
    expect(e.content).toEqual([{ type: 'text', text: 'all good' }]);
  });

  it('preserves Anthropic image blocks as raw transient content', () => {
    const e = firstRaw([userToolResult([
      { type: 'text', text: 'shot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SAMPLE_BASE64 } },
    ])]);
    expect(e.output).toBe('shot\n[image]');
    expect(e.content).toHaveLength(2);
    expect(e.content![1]).toEqual({ type: 'image', data: SAMPLE_BASE64, mimeType: 'image/png' });
  });

  it('keeps resource_link blocks instead of dropping them', () => {
    const e = firstRaw([userToolResult([
      { type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt', mimeType: 'text/plain' },
    ])]);
    expect(e.content).toEqual([
      { type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt', mimeType: 'text/plain' },
    ]);
  });

  it('wraps mcpMeta.structuredContent into a structured block', () => {
    const translator = new StreamTranslator();
    const events = translator.feed(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'rows' }] }],
        mcpMeta: { structuredContent: { rows: 7 }, _meta: { a: 1 } },
      },
    }));
    const withStructured = events.find((ev): ev is ToolResultEvent => ev.type === 'tool_result')!;
    expect(withStructured.content).toEqual([
      { type: 'text', text: 'rows' },
      { type: 'structured', value: { rows: 7 } },
    ]);
  });

  it('string content still produces a single text block (legacy shape)', () => {
    const e = firstRaw([userToolResult('plain string output')]);
    expect(e.output).toBe('plain string output');
    expect(e.content).toEqual([{ type: 'text', text: 'plain string output' }]);
  });

  it('is_error results carry the text in error and ok=false', () => {
    const e = firstRaw([userToolResult([{ type: 'text', text: 'boom' }], { is_error: true })]);
    expect(e.ok).toBe(false);
    expect(e.error).toBe('boom');
  });

  it('drop-through: unknown block shapes are skipped without breaking the event', () => {
    const e = firstRaw([userToolResult([
      { type: 'tool_reference', id: 'x' },
      { type: 'text', text: 'kept' },
    ])]);
    expect(e.content).toEqual([{ type: 'text', text: 'kept' }]);
  });
});

describe('stream-translator: nested sub-agent tools', () => {
  it('assistant frames with parent_tool_use_id become parented tool_use events', () => {
    const translator = new StreamTranslator();
    const events = translator.feed(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'seat-w',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-nested', name: 'Edit', input: { file_path: 'src/Login.tsx' } }],
      },
    }));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        id: 'tu-nested',
        tool: 'Edit',
        parentId: 'seat-w',
        input: { file_path: 'src/Login.tsx' },
      }),
    ]);
  });

  it('stamps parentId on nested user tool_result frames', () => {
    const translator = new StreamTranslator();
    const events = translator.feed(JSON.stringify({
      type: 'user',
      parent_tool_use_id: 'seat-w',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-nested', content: [{ type: 'text', text: 'ok' }] }],
      },
    }));
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      id: 'tu-nested',
      parentId: 'seat-w',
      ok: true,
    });
  });
});

describe('stream-translator: PR-4 rich-result fixture (docs/fixtures/tool-extension)', () => {
  const fixturePath = join(__dirname, '../../../docs/fixtures/tool-extension/pr4-rich-result.ndjson');

  it('every tool_result line in the fixture yields structured content, and the pump strips base64', async () => {
    let raw: string;
    try {
      raw = readFileSync(fixturePath, 'utf8');
    } catch {
      // The fixture ships with the PR; if absent (partial checkout) skip.
      return;
    }
    const translator = new StreamTranslator();
    const events = raw.split('\n').filter((l) => l.trim() !== '').map((l) => translator.feed(l)).flat();
    const results = events.filter((ev): ev is ToolResultEvent => ev.type === 'tool_result');
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const result of results) {
      expect(result.content).toBeDefined();
      expect(result.content!.length).toBeGreaterThan(0);
    }

    // The image line must produce a transient image block (after its text)...
    const image = results.find((r) => r.id === 'toolu_img');
    expect(image?.content?.map((b) => b.type)).toEqual(['text', 'image']);
    expect(image?.content?.[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });

    // ...and after the materialization pump (the only path into the
    // reducer / history) NO block may carry raw data/blob/base64 anymore.
    const cacheRoot = 'C:/appdata/tool-cache';
    const store: ToolResultStore = {
      writeBinary: async ({ mimeType }) => ({
        id: 'bin-x', storage: 'ephemeral-tool-cache',
        path: `${cacheRoot}/aa/aa11.${mimeType.split('/')[1] ?? 'bin'}`,
        mimeType, size: 100, sha256: 'a'.repeat(64),
      }),
      readBinaryBytes: async () => null,
      cacheRoot: async () => cacheRoot,
    };
    const out = await materializeToolResultEvents(results, store);
    for (const ev of out) {
      const e = ev as ToolResultEvent;
      const serialized = JSON.stringify(e.content ?? []);
      expect(serialized).not.toMatch(/"(data|blob)"/);
      expect(serialized).not.toContain(SAMPLE_BASE64);
    }
    const materializedImage = (out.find((ev) => (ev as ToolResultEvent).id === 'toolu_img') as ToolResultEvent);
    expect(materializedImage.content![1]).toMatchObject({ type: 'image' });
    expect((materializedImage.content![1] as { ref?: unknown }).ref).toBeDefined();
  });
});

describe('stream-translator: terminal `result` events (mid-run abort must finalize as error)', () => {
  function feedAll(lines: unknown[]) {
    const translator = new StreamTranslator();
    const out: Array<unknown> = [];
    for (const line of lines) {
      for (const ev of translator.feed(JSON.stringify(line))) {
        out.push(ev as unknown);
      }
    }
    return out;
  }

  it('maps `error_during_execution` to a loop_end with isError and the real reason', () => {
    const out = feedAll([
      { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, errors: ['API gateway returned 529 (overloaded)'] },
    ]);
    const loopEnd = out.find((e) => (e as { type: string }).type === 'loop_end') as
      { isError?: boolean; finalResult: string } | undefined;
    expect(loopEnd).toBeDefined();
    expect(loopEnd!.isError).toBe(true);
    expect(loopEnd!.finalResult).toContain('529');
    // The failure text must also surface as a visible transcript message.
    expect(out.some((e) => (e as { type: string }).type === 'text')).toBe(true);
  });

  it('maps max-turns / budget / retries variants to a terminal error loop_end', () => {
    for (const subtype of ['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']) {
      const out = feedAll([{ type: 'result', subtype, is_error: true }]);
      const loopEnd = out.find((e) => (e as { type: string }).type === 'loop_end') as
        { isError?: boolean; finalResult: string } | undefined;
      expect(loopEnd, subtype).toBeDefined();
      expect(loopEnd!.isError, subtype).toBe(true);
      expect(loopEnd!.finalResult, subtype).toContain('error');
    }
  });

  it('a `success` result is NOT treated as an error', () => {
    const out = feedAll([{ type: 'result', subtype: 'success', result: 'done', stop_reason: 'end_turn' }]);
    const loopEnd = out.find((e) => (e as { type: string }).type === 'loop_end') as
      { isError?: boolean } | undefined;
    expect(loopEnd).toBeDefined();
    expect(loopEnd!.isError).toBeFalsy();
  });
});
