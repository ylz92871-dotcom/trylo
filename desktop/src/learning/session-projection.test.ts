// session-projection.ts：ConversationRecord → Hermes session 投影（spec §1 / §7.4）。
// 纯函数测试 —— 确定性是镜像去重的前提。

import { describe, it, expect } from 'vitest';

import type { ChatMessage } from '../components/chat/types';
import type { ConversationRecord } from '../host-adapter/conversation-history';
import { isProjectableSession, projectSession, toolCategory } from './session-projection';

function user(id: string, text: string, turnId = id, createdAt = 1_700_000_000_000): ChatMessage {
  return {
    id,
    role: 'user',
    kind: 'text',
    text,
    createdAt,
    turnId,
    turnStartedAt: createdAt,
  } as unknown as ChatMessage;
}

function assistant(id: string, text: string, turnId: string, createdAt = 1_700_000_001_000): ChatMessage {
  return {
    id,
    role: 'assistant',
    kind: 'text',
    text,
    createdAt,
    turnId,
  } as unknown as ChatMessage;
}

function tool(id: string, turnId: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    kind: 'tool',
    tool: 'Read',
    summary: 'Read src/app.ts',
    status: 'done',
    createdAt: 1_700_000_000_500,
    turnId,
    toolCallId: `call-${id}`,
  } as unknown as ChatMessage;
}

function record(messages: readonly ChatMessage[], overrides = {}): ConversationRecord {
  return {
    session: { id: 'sess-1', title: 'Demo', mode: 'code', createdAt: 1, updatedAt: 2, turnCount: 1, ...overrides } as never,
    messages: [...messages],
    draft: '',
  };
}

describe('projectSession', () => {
  it('maps id / title / workspace / model', () => {
    const projection = projectSession({
      record: record([]),
      workspacePath: 'd:/repo',
      model: 'claude-sonnet-4',
    });
    expect(projection.id).toBe('sess-1');
    expect(projection.title).toBe('Demo');
    expect(projection.workspace).toEqual({ path: 'd:/repo' });
    expect(projection.model).toBe('claude-sonnet-4');
    expect(projection.turns).toEqual([]);
  });

  it('pairs a user prompt with the assistant replies of the same turn', () => {
    const projection = projectSession({
      record: record([
        user('u1', 'hello'),
        tool('t1', 'u1'),
        assistant('a1', 'hi there', 'u1'),
        assistant('a2', 'and more', 'u1'),
      ]),
      workspacePath: 'd:/repo',
    });
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]!.prompt).toBe('hello');
    expect(projection.turns[0]!.resultText).toBe('hi there\nand more');
    expect(projection.turns[0]!.events).toEqual([{
      id: 'call-t1',
      category: 'read',
      title: 'Read src/app.ts',
      status: 'done',
    }]);
  });

  it('is deterministic — the same record always yields the same projection', () => {
    const input = {
      record: record([user('u1', 'q'), assistant('a1', 'a', 'u1')]),
      workspacePath: 'd:/repo',
    };
    expect(projectSession(input)).toEqual(projectSession(input));
  });

  it('skips streaming (partial) assistant fragments', () => {
    const partial = { ...assistant('a1', 'streaming…', 'u1'), partial: true } as ChatMessage;
    const projection = projectSession({
      record: record([user('u1', 'q'), partial, assistant('a2', 'final', 'u1')]),
      workspacePath: 'd:/repo',
    });
    expect(projection.turns[0]!.resultText).toBe('final');
  });

  it('keeps tool summaries but ignores notice/thinking bodies', () => {
    const notice = { id: 'n1', role: 'assistant', kind: 'notice', text: 'saved', createdAt: 1, turnId: 'u1' } as unknown as ChatMessage;
    const projection = projectSession({
      record: record([user('u1', 'q'), notice, tool('t1', 'u1')]),
      workspacePath: 'd:/repo',
    });
    expect(projection.turns).toEqual([]);
  });

  it('drops an assistant fragment with no user turn (truncated history)', () => {
    const projection = projectSession({
      record: record([assistant('a0', 'orphan', 'missing-turn')]),
      workspacePath: 'd:/repo',
    });
    expect(projection.turns).toEqual([]);
  });

  it('groups by turnId so edit-and-resend cannot shift the pairing', () => {
    const resent = { ...user('u1', 'edited question'), turnStartedAt: 1_700_000_005_000 } as ChatMessage;
    const projection = projectSession({
      record: record([
        user('u1', 'original'),
        assistant('a1', 'old answer', 'u1'),
        resent,
        assistant('a2', 'new answer', 'u1'),
      ]),
      workspacePath: 'd:/repo',
    });
    // One turn, keyed by turnId: the resend replaces the prompt in place.
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]!.prompt).toBe('original');
    expect(projection.turns[0]!.resultText).toBe('old answer\nnew answer');
  });

  it('keeps multiple turns in order', () => {
    const projection = projectSession({
      record: record([
        user('u1', 'first'),
        assistant('a1', 'one', 'u1'),
        user('u2', 'second'),
        assistant('a2', 'two', 'u2'),
      ]),
      workspacePath: 'd:/repo',
    });
    expect(projection.turns.map((t) => t.prompt)).toEqual(['first', 'second']);
    expect(projection.turns.map((t) => t.resultText)).toEqual(['one', 'two']);
  });

  it('derives startedAt from turnStartedAt as an ISO timestamp', () => {
    const withAnswer = projectSession({
      record: record([user('u1', 'q', 'u1', 1_700_000_000_000), assistant('a1', 'a', 'u1')]),
      workspacePath: 'd:/repo',
    });
    expect(withAnswer.turns[0]!.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('never throws on missing input and yields an empty projection', () => {
    expect(() => projectSession({ record: undefined as never, workspacePath: '' })).not.toThrow();
    const projection = projectSession({ record: undefined as never, workspacePath: '' });
    expect(projection).toEqual({ id: '', title: '', workspace: { path: '' }, model: undefined, turns: [] });
  });
});

describe('isProjectableSession', () => {
  it('requires an id and at least one complete exchange', () => {
    expect(isProjectableSession(projectSession({ record: record([user('u1', 'q')]), workspacePath: 'd:/repo' }))).toBe(false);
    expect(
      isProjectableSession(projectSession({ record: record([user('u1', 'q'), assistant('a1', 'a', 'u1')]), workspacePath: 'd:/repo' })),
    ).toBe(true);
    // 空记录与无 id 的会话都不值得镜像。
    expect(isProjectableSession(projectSession({ record: record([]), workspacePath: 'd:/repo' }))).toBe(false);
    expect(isProjectableSession(projectSession({ record: undefined as never, workspacePath: '' }))).toBe(false);
  });
});

describe('toolCategory — Work surface first (spec §2.5)', () => {
  it('locks the production Office / browser / desktop tool names', () => {
    expect(toolCategory('mcp__trylo-office__officecli')).toBe('office');
    expect(toolCategory('mcp__trylo-office__whatever')).toBe('office');
    expect(toolCategory('browser_take_screenshot')).toBe('browser');
    expect(toolCategory('mcp__chrome-devtools__eval')).toBe('browser');
    expect(toolCategory('mcp__playwright__goto')).toBe('browser');
    expect(toolCategory('mcp__windows__click')).toBe('desktop');
    expect(toolCategory('mcp__windows-mcp__move')).toBe('desktop');
  });

  it('still classifies Code tools', () => {
    expect(toolCategory('Read')).toBe('read');
    expect(toolCategory('Bash')).toBe('command');
    expect(toolCategory('Greet')).toBe('tool');
  });
});
