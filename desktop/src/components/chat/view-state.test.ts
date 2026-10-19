import { describe, expect, it } from 'vitest';
import {
  deriveConversationRunViewState,
  viewStateLabel,
  viewStateShowsFooterDots,
  viewStateShowsHeaderPulse,
  viewStateTone,
} from './view-state';
import type { ChatMessage, TextMessage } from './types';

function user(text = 'hello', at = 1000): TextMessage {
  return { id: `u${at}`, role: 'user', kind: 'text', createdAt: at, text };
}
function thinking(partial: boolean): ChatMessage {
  return {
    id: 't1',
    role: 'assistant',
    kind: 'thinking',
    createdAt: 1100,
    summary: 'x',
    preview: 'x',
    fullLength: 1,
    partial,
    turn: 1,
  };
}
function toolRunning(): ChatMessage {
  return {
    id: 'tool-1',
    role: 'assistant',
    kind: 'tool',
    tool: 'Read',
    status: 'running',
    summary: 'Read a.ts',
    createdAt: 1200,
  };
}
function partialText(): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    kind: 'text',
    text: 'answer',
    partial: true,
    createdAt: 1300,
  };
}
function pendingApproval(): ChatMessage {
  return {
    id: 'ap1',
    role: 'assistant',
    kind: 'approval',
    approvalId: 'work:run-1:req-1',
    type: 'tool',
    description: 'Run mkdir?',
    status: 'pending',
    authority: 'work',
    createdAt: 1400,
  };
}
function pendingInputRequest(): ChatMessage {
  return {
    id: 'ir1',
    role: 'assistant',
    kind: 'input_request',
    requestId: 'req-9',
    questions: [],
    status: 'pending',
    createdAt: 1400,
  };
}

describe('deriveConversationRunViewState (spec §5.3)', () => {
  it('returns idle when nothing is running', () => {
    expect(deriveConversationRunViewState({ messages: [], running: false })).toBe('idle');
  });

  it('returns preparing when a Code run starts with no output yet', () => {
    expect(deriveConversationRunViewState({ messages: [user()], running: true })).toBe('waiting_first_output');
    expect(deriveConversationRunViewState({ messages: [], running: true })).toBe('preparing');
  });

  it('returns thinking while a thinking card is still partial', () => {
    expect(
      deriveConversationRunViewState({ messages: [user(), thinking(true)], running: true }),
    ).toBe('thinking');
  });

  it('returns tool_running while a tool is running', () => {
    expect(
      deriveConversationRunViewState({ messages: [user(), toolRunning()], running: true }),
    ).toBe('tool_running');
  });

  it('returns finalizing while the final text is still partial', () => {
    expect(
      deriveConversationRunViewState({ messages: [user(), partialText()], running: true }),
    ).toBe('finalizing');
  });

  it('returns waiting_first_output when running but nothing visible yet', () => {
    expect(deriveConversationRunViewState({ messages: [user()], running: true })).toBe(
      'waiting_first_output',
    );
  });

  it('parks on awaiting_input while an approval is unanswered', () => {
    // No footer dots, no loader, no pulse: the agent is blocked on
    // the user, so every loop animation must be off. Before this,
    // the wait read as waiting_first_output and the dots bounced
    // "正在准备" at a run that was going nowhere.
    expect(
      deriveConversationRunViewState({ messages: [user(), pendingApproval()], running: true }),
    ).toBe('awaiting_input');
    expect(
      deriveConversationRunViewState({ messages: [user(), pendingInputRequest()], running: true }),
    ).toBe('awaiting_input');
  });

  it('work that resumed after an approval leaves the parked state', () => {
    // First hit from the newest message wins: a running tool NEWER
    // than the stale pending approval means the run moved on.
    expect(
      deriveConversationRunViewState({
        messages: [user(), pendingApproval(), toolRunning()],
        running: true,
      }),
    ).toBe('tool_running');
  });

  it('a resolved approval falls through to the older tail', () => {
    const approved = { ...pendingApproval(), status: 'approved' } as ChatMessage;
    expect(
      deriveConversationRunViewState({ messages: [user(), approved], running: true }),
    ).toBe('waiting_first_output');
  });

  it('a Code spawn error is a failure', () => {
    expect(
      deriveConversationRunViewState({ messages: [user()], running: false, error: true }),
    ).toBe('failed');
  });

  it('does not claim to prepare again after a tool finished in the current turn', () => {
    const completed = { ...toolRunning(), status: 'done' } as ChatMessage;
    expect(deriveConversationRunViewState({ messages: [user(), completed], running: true })).toBe('waiting_model');
    expect(deriveConversationRunViewState({ messages: [user(), completed, user('next', 2000)], running: true })).toBe('waiting_first_output');
  });

  it('keeps parallel work and pending approvals visible after another tool finishes', () => {
    const done = { ...toolRunning(), id: 'finished', status: 'done' } as ChatMessage;
    expect(deriveConversationRunViewState({ messages: [user(), toolRunning(), done], running: true })).toBe('tool_running');
    expect(deriveConversationRunViewState({ messages: [user(), pendingApproval(), done], running: true })).toBe('awaiting_input');
    expect(deriveConversationRunViewState({ messages: [user(), done], running: false })).toBe('idle');
  });

  it('a spawn error wins over a running state', () => {
    expect(
      deriveConversationRunViewState({ messages: [user(), toolRunning()], running: true, error: true }),
    ).toBe('failed');
  });
});

describe('view-state motion helpers (spec §7.2)', () => {
  it('footer heartbeat covers startup and thinking at the newest timeline point', () => {
    expect(viewStateShowsFooterDots('preparing')).toBe(true);
    expect(viewStateShowsFooterDots('waiting_first_output')).toBe(true);
    expect(viewStateShowsFooterDots('waiting_model')).toBe(true);
    expect(viewStateShowsFooterDots('thinking')).toBe(true);
    for (const s of [
      'idle',
      'tool_running',
      'finalizing',
      'reconnecting',
      'completed',
      'failed',
      'cancelled',
    ] as const) {
      expect(viewStateShowsFooterDots(s)).toBe(false);
    }
  });

  it('header pulses in every active phase, never when parked or terminal', () => {
    // The header dot is the fixed always-visible heartbeat: it stays
    // on beside any timeline primary, and off wherever the run is
    // parked (awaiting_input) or over.
    for (const s of [
      'preparing',
      'waiting_first_output',
      'waiting_model',
      'thinking',
      'tool_running',
      'finalizing',
      'reconnecting',
    ] as const) {
      expect(viewStateShowsHeaderPulse(s), s).toBe(true);
    }
    for (const s of ['idle', 'awaiting_input', 'completed', 'failed', 'cancelled'] as const) {
      expect(viewStateShowsHeaderPulse(s), s).toBe(false);
    }
  });

  it('maps tones for dot color', () => {
    expect(viewStateTone('idle')).toBe('ready');
    expect(viewStateTone('completed')).toBe('ready');
    expect(viewStateTone('thinking')).toBe('running');
    expect(viewStateTone('failed')).toBe('error');
    expect(viewStateTone('cancelled')).toBe('error');
  });

  it('labels every state exactly once (Round-3 P2: one wording, all surfaces)', () => {
    // ProcessHeader and StreamingIndicator both render this map. A fourth
    // phrasing invented in either component breaks this contract first.
    expect(viewStateLabel('idle')).toBe('已就绪');
    expect(viewStateLabel('preparing')).toBe('正在准备…');
    expect(viewStateLabel('waiting_first_output')).toBe('正在准备…');
    expect(viewStateLabel('waiting_model')).toBe('等待模型响应…');
    expect(viewStateLabel('thinking')).toBe('思考中…');
    expect(viewStateLabel('tool_running')).toBe('正在执行…');
    expect(viewStateLabel('finalizing')).toBe('正在收尾…');
    expect(viewStateLabel('awaiting_input')).toBe('等待你的回复');
    expect(viewStateLabel('reconnecting')).toBe('正在重新连接…');
    expect(viewStateLabel('completed')).toBe('已完成');
    expect(viewStateLabel('failed')).toBe('失败');
    expect(viewStateLabel('cancelled')).toBe('已停止');
  });
});
