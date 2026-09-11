// Trylo Desktop — work-item-mapper unit tests.
//
// v1.16.5+ (M3, Phase C/H): pins the "ConversationItem →
// ChatMessage" aggregation contract of the Work capability:
// one thinking card per run, tool upsert by id, artifact
// dedupe per turn, terminal items freeze the card, and raw
// diagnostics never touch the visible message array.

import { describe, it, expect } from 'vitest';
import type { ConversationItem } from '@trylo/work';
import {
  applyWorkItem,
  resolveArtifactKind,
} from './work-item-mapper';
import type { ChatMessage, TextMessage } from './types';

function userMessage(id: string, at = 1000): TextMessage {
  // beginConversationTurn (spec §6.1) stamps turnStartedAt
  // on every Work send — the timer freeze tests depend on it.
  return {
    id, kind: 'text', role: 'user', createdAt: at, turnStartedAt: at, text: 'do it',
  };
}

const CONVERSATION_ID = 'conv-1';

// v1.16.5+ (M3 closure spec §2.4): every item carries its
// run identity; the mapper derives turn membership from
// it, never from surrounding messages.
// 2026-09-01 (New direction): task-intent items reuse Code's
// ordinary card UI — IDENTITY carries `intent: 'task'` so the
// shared-card tests exercise the Code-parity path (deliverable
// stays Work-specific).
const IDENTITY = {
  taskId: 'task-1', runId: 'run:task-1', turnId: 'u1', intent: 'task',
} as const;
// Legacy (no intent) identity for recovered-run tests — these
// render terminal content only, never executor scaffolding.
const LEGACY = { taskId: 'task-1', runId: 'run:task-1', turnId: 'u1' } as const;

const thinking = (
  text: string,
  at: number,
  turnId = 'u1',
  phaseId?: string,
): ConversationItem => ({
  ...IDENTITY, turnId,
  kind: 'thinking', id: `th-${at}`, at, conversationId: CONVERSATION_ID, text, phaseId,
});
const plan = (
  name: string,
  stage: 'started' | 'finished',
  at: number,
  phaseId?: string,
): ConversationItem => ({
  ...IDENTITY,
  kind: 'plan', id: `pl-${at}`, at, conversationId: CONVERSATION_ID, stage, name, text: name, phaseId,
});
const progress = (text: string, at: number, toolCallId?: string): ConversationItem => ({
  ...IDENTITY,
  kind: 'progress', id: `pr-${at}`, at, conversationId: CONVERSATION_ID, text, toolCallId,
});
const tool = (
  stepId: string,
  status: 'running' | 'done' | 'error',
  at: number,
  phaseId?: string,
): ConversationItem => ({
  ...IDENTITY,
  kind: 'tool', id: `tool-${stepId}`, at, conversationId: CONVERSATION_ID,
  tool: 'read_file', summary: `read_file ${status}`, status, phaseId,
  // Spec §6.4: the stable invocation id IS the upstream
  // stepId — command output routes back via it.
  toolCallId: stepId,
});
const artifact = (filePath: string, at: number): ConversationItem => ({
  ...IDENTITY,
  kind: 'artifact', id: `art-${at}`, at, conversationId: CONVERSATION_ID,
  filePath, artifactKind: undefined,
});

describe('work-item-mapper: thinking / plan / progress aggregation', () => {
  it('consecutive thinking items fold into ONE card per turn', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('first thought', 1001));
    msgs = applyWorkItem(msgs, thinking('second thought', 1002));
    expect(msgs.filter((m) => m.kind === 'thinking')).toHaveLength(1);
    const card = msgs.find((m) => m.kind === 'thinking');
    expect(card?.kind === 'thinking' && card.preview).toContain('first thought');
    expect(card?.kind === 'thinking' && card.preview).toContain('second thought');
    expect(card?.kind === 'thinking' && card.partial).toBe(true);
    expect(card?.turnId).toBe('u1');
  });

  it('plan stages produce no chat rows on the Code-parity path', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, plan('DISCOVER', 'started', 1001));
    msgs = applyWorkItem(msgs, plan('Completed DISCOVER', 'finished', 1002));
    // 2026-09-01 (New direction): plan renders like Code — there is
    // no plan-derived ThinkingMessage and no WorkflowMessage. Those
    // live in Diagnostics for Work, exactly as they do for Code.
    expect(msgs.filter((m) => m.kind === 'thinking')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'workflow')).toHaveLength(0);
    expect(msgs).toHaveLength(1); // user bubble only — plan hidden
  });

  it('progress only updates the activity line of an active card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('reasoning', 1001));
    msgs = applyWorkItem(msgs, progress('Reading notes.md', 1002));
    const card = msgs.find((m) => m.kind === 'thinking');
    expect(card?.kind === 'thinking' && card.activity).toBe('Reading notes.md');
    // preview is untouched by progress markers.
    expect(card?.kind === 'thinking' && card.preview).not.toContain('Reading notes.md');
  });

  it('progress without an active card is dropped (stays in Diagnostics)', () => {
    const msgs: readonly ChatMessage[] = [userMessage('u1')];
    const next = applyWorkItem(msgs, progress('step started', 1002));
    expect(next).toBe(msgs);
  });

  it('repeated identical progress does not churn the array', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('r', 1001));
    msgs = applyWorkItem(msgs, progress('same line', 1002));
    const next = applyWorkItem(msgs, progress('same line', 1003));
    expect(next).toBe(msgs);
  });

  it('a second turn gets its own thinking card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('turn one', 1001));
    msgs = [...msgs, userMessage('u2', 2000)];
    msgs = applyWorkItem(msgs, thinking('turn two', 2001, 'u2'));
    expect(msgs.filter((m) => m.kind === 'thinking')).toHaveLength(2);
  });
});

describe('work-item-mapper: phase grouping (spec §6.3)', () => {
  type Card = { phaseId?: string; partial: boolean; summary: string; preview: string; activity?: string };

  const cards = (msgs: readonly ChatMessage[]) =>
    msgs.filter((m) => m.kind === 'thinking') as unknown as Card[];

  it('a new groupId opens a new phase card (Code parity — no WorkflowMessage)', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, plan('DISCOVER', 'started', 1001, 'g1'));
    msgs = applyWorkItem(msgs, thinking('scanning repo', 1002, 'u1', 'g1'));
    msgs = applyWorkItem(msgs, plan('PLAN', 'started', 1004, 'g2'));
    msgs = applyWorkItem(msgs, thinking('drafting plan', 1005, 'u1', 'g2'));
    // Plan events render nothing (Code parity); the two
    // ThinkingCards come from the groupId on each thinking item.
    const ts = msgs.filter((m) => m.kind === 'thinking');
    expect(ts).toHaveLength(2);
    expect(ts[0]?.kind === 'thinking' && ts[0].phaseId).toBe('g1');
    expect(ts[1]?.kind === 'thinking' && ts[1].phaseId).toBe('g2');
    expect(ts[1]?.kind === 'thinking' && ts[1].summary).toBe('drafting plan');
    expect(msgs.filter((m) => m.kind === 'workflow')).toHaveLength(0);
  });

  it('the same groupId keeps ONE card even across a tool step', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('first', 1001, 'u1', 'g1'));
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1002, 'g1'));
    msgs = applyWorkItem(msgs, tool('s1', 'done', 1003, 'g1'));
    msgs = applyWorkItem(msgs, thinking('second after tool', 1004, 'u1', 'g1'));
    expect(msgs.filter((m) => m.kind === 'thinking')).toHaveLength(1);
    const [c1] = cards(msgs);
    expect(c1?.preview).toContain('second after tool');
  });

  it('without a groupId, reasoning resumed after a tool opens a new default phase', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('first', 1001));
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1002));
    msgs = applyWorkItem(msgs, tool('s1', 'done', 1003));
    msgs = applyWorkItem(msgs, thinking('second', 1004));
    const [c1, c2] = cards(msgs);
    expect(c1?.phaseId).toBeUndefined();
    expect(c1?.partial).toBe(false);
    expect(c2?.phaseId).toBeUndefined();
    expect(c2?.partial).toBe(true);
    expect(c2?.preview).toContain('second');
  });

  it('without a groupId, consecutive thinking (no tool between) shares one card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('a', 1001));
    msgs = applyWorkItem(msgs, thinking('b', 1002));
    expect(msgs.filter((m) => m.kind === 'thinking')).toHaveLength(1);
  });

  it('progress lands on the active phase card, not a completed one', () => {
    // Plan is no longer required to create phase
    // boundaries: two thinking items with different
    // groupIds create two thinking cards. The first is
    // completed when the second opens its own phase.
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('discover', 1001, 'u1', 'g1'));
    msgs = applyWorkItem(msgs, thinking('plan', 1002, 'u1', 'g2'));
    msgs = applyWorkItem(msgs, progress('Reading notes.md', 1003));
    const [c1, c2] = cards(msgs);
    expect(c1?.partial).toBe(false);
    expect(c2?.activity).toBe('Reading notes.md');
    expect(c2?.preview).not.toContain('Reading notes.md');
  });

  it('final freezes every phase card of the run', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('discover', 1001, 'u1', 'g1'));
    msgs = applyWorkItem(msgs, thinking('plan', 1002, 'u1', 'g2'));
    msgs = applyWorkItem(
      msgs,
      { ...IDENTITY, kind: 'final', id: 'f1', at: 1003, conversationId: CONVERSATION_ID, text: 'done' },
    );
    for (const c of cards(msgs)) expect(c.partial).toBe(false);
  });
});

describe('work-item-mapper: tool state transitions', () => {
  it('running → done updates ONE card in place and records duration', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1000));
    msgs = applyWorkItem(msgs, tool('s1', 'done', 1600));
    const tools = msgs.filter((m) => m.kind === 'tool');
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t?.kind === 'tool' && t.status).toBe('done');
    expect(t?.kind === 'tool' && t.durationMs).toBe(600);
  });

  it('running → error marks the card failed', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s2', 'running', 1000));
    msgs = applyWorkItem(msgs, tool('s2', 'error', 1100));
    const t = msgs.find((m) => m.kind === 'tool');
    expect(t?.kind === 'tool' && t.status).toBe('error');
  });

  it('different steps produce distinct cards', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1000));
    msgs = applyWorkItem(msgs, tool('s2', 'running', 1001));
    expect(msgs.filter((m) => m.kind === 'tool')).toHaveLength(2);
  });
});

describe('work-item-mapper: artifacts', () => {
  it('first emit appends, re-emit updates the same card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, artifact('D:/repo/.trylo/out/a.md', 1001));
    msgs = applyWorkItem(msgs, artifact('D:/repo/.trylo/out/a.md', 1050));
    const arts = msgs.filter((m) => m.kind === 'artifact');
    expect(arts).toHaveLength(1);
    expect(arts[0]?.kind === 'artifact' && arts[0].updated).toBe(true);
    expect(arts[0]?.kind === 'artifact' && arts[0].updatedAt).toBe(1050);
  });
});

describe('work-item-mapper: terminal states', () => {
  it('final appends an assistant text and freezes the thinking card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('reasoning', 1001));
    msgs = applyWorkItem(
      msgs,
      {
        ...IDENTITY,
        kind: 'final', id: 'f1', at: 1002,
        conversationId: CONVERSATION_ID, text: 'All done.',
      },
    );
    const final = msgs[msgs.length - 1];
    expect(final?.kind === 'text' && final.role).toBe('assistant');
    expect(final?.kind === 'text' && final.text).toBe('All done.');
    const card = msgs.find((m) => m.kind === 'thinking');
    expect(card?.kind === 'thinking' && card.partial).toBe(false);
  });

  it('error appends an ErrorMessage and freezes the thinking card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('reasoning', 1001));
    msgs = applyWorkItem(
      msgs,
      {
        ...IDENTITY,
        kind: 'error', id: 'e1', at: 1002,
        conversationId: CONVERSATION_ID,
        userMessage: 'Completion blocked', diagnosticId: 'diag-9',
      },
    );
    const err = msgs[msgs.length - 1];
    expect(err?.kind).toBe('error');
    expect(err?.kind === 'error' && err.diagnosticId).toBe('diag-9');
    const card = msgs.find((m) => m.kind === 'thinking');
    expect(card?.kind === 'thinking' && card.partial).toBe(false);
  });

  it('progress after the run ended does not revive the card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('reasoning', 1001));
    msgs = applyWorkItem(
      msgs,
      { ...IDENTITY, kind: 'final', id: 'f1', at: 1002, conversationId: CONVERSATION_ID, text: 'done' },
    );
    const next = applyWorkItem(msgs, progress('late step', 1003));
    expect(next).toBe(msgs);
  });

  it('diagnostics items never touch the visible array', () => {
    const msgs: readonly ChatMessage[] = [userMessage('u1')];
    const next = applyWorkItem(
      msgs,
      { ...IDENTITY, kind: 'diagnostics', id: 'd1', at: 1001, conversationId: CONVERSATION_ID, text: 'api_retry' },
    );
    expect(next).toBe(msgs);
  });

  it('final interrupts the run\'s still-running tools, not other runs\'', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1000));
    // A tool from a different run (no persisted turnId →
    // synthetic key) must not be touched.
    msgs = applyWorkItem(
      msgs,
      {
        taskId: 'task-2', runId: 'run:task-2', turnId: undefined, intent: 'task',
        kind: 'tool', id: 'tool-s9', at: 1001, conversationId: CONVERSATION_ID,
        tool: 'read_file', summary: 'other run', status: 'running',
      },
    );
    msgs = applyWorkItem(
      msgs,
      { ...IDENTITY, kind: 'final', id: 'f1', at: 1002, conversationId: CONVERSATION_ID, text: 'done' },
    );
    const tools = msgs.filter((m) => m.kind === 'tool');
    const t1 = tools.find((m) => m.id === 'tool-s1');
    const t9 = tools.find((m) => m.id === 'tool-s9');
    expect(t1?.kind === 'tool' && t1.status).toBe('interrupted');
    expect(t9?.kind === 'tool' && t9.status).toBe('running');
  });

  it('cancelled appends an explicit system state, not success or failure', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1000));
    msgs = applyWorkItem(
      msgs,
      {
        ...IDENTITY,
        kind: 'cancelled', id: 'c1', at: 1002,
        conversationId: CONVERSATION_ID, text: 'Run cancelled',
      },
    );
    const last = msgs[msgs.length - 1];
    expect(last?.kind).toBe('text');
    expect(last?.kind === 'text' && last.role).toBe('system');
    expect(last?.kind === 'text' && last.text).toBe('Run cancelled');
    const t = msgs.find((m) => m.kind === 'tool');
    expect(t?.kind === 'tool' && t.status).toBe('interrupted');
  });
});

describe('work-item-mapper: resolveArtifactKind', () => {
  it('accepts a known upstream hint as-is', () => {
    expect(resolveArtifactKind('presentation', 'x.bin')).toBe('presentation');
  });

  it('ignores an unknown hint and derives from the extension', () => {
    expect(resolveArtifactKind('mystery', 'D:/repo/site/index.html')).toBe('web');
  });

  // P2-1 (spec §8.6): unknown extensions are a generic `file`, never a
  // pretend document.
  it('falls back to a generic file for unknown extensions', () => {
    expect(resolveArtifactKind(undefined, 'D:/repo/data.xyz')).toBe('file');
  });
});

describe('work-item-mapper: turn timer freeze (spec §6.6.4)', () => {
  const userTimer = (msgs: readonly ChatMessage[]): number | undefined => {
    const u = msgs.find((m) => m.kind === 'text' && m.role === 'user');
    return u?.kind === 'text' ? u.finalElapsedMs : undefined;
  };

  it('progress markers do NOT freeze the timer — it keeps counting (2026-08-28)', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1', 1000)];
    msgs = applyWorkItem(msgs, thinking('reasoning begins', 1050));
    expect(userTimer(msgs)).toBeUndefined();
    msgs = applyWorkItem(msgs, plan('DISCOVER', 'started', 1060));
    expect(userTimer(msgs)).toBeUndefined();
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1070));
    expect(userTimer(msgs)).toBeUndefined();
  });

  it('only the terminal item freezes at the FULL run duration', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1', 1000)];
    msgs = applyWorkItem(msgs, thinking('reasoning begins', 1050));
    msgs = applyWorkItem(msgs, plan('DISCOVER', 'started', 1060));
    msgs = applyWorkItem(
      msgs,
      { ...IDENTITY, kind: 'final', id: 'f1', at: 2000, conversationId: CONVERSATION_ID, text: 'done' },
    );
    expect(userTimer(msgs)).toBe(1000);
  });

  it('a cancelled terminal freezes the timer when no output arrived first', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1', 1000)];
    msgs = applyWorkItem(
      msgs,
      {
        ...IDENTITY,
        kind: 'cancelled', id: 'c1', at: 1030,
        conversationId: CONVERSATION_ID, text: 'Run cancelled',
      },
    );
    expect(userTimer(msgs)).toBe(30);
  });

  it('the frozen value is never overwritten by a later item', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1', 1000)];
    msgs = applyWorkItem(
      msgs,
      { ...IDENTITY, kind: 'final', id: 'f1', at: 1500, conversationId: CONVERSATION_ID, text: 'done' },
    );
    expect(userTimer(msgs)).toBe(500);
    msgs = applyWorkItem(
      msgs,
      { ...IDENTITY, kind: 'error', id: 'e1', at: 2000, conversationId: CONVERSATION_ID, userMessage: 'x', diagnosticId: 'd1' },
    );
    expect(userTimer(msgs)).toBe(500);
  });

  it('a recovered run without a persisted turnId has no user bubble to freeze', () => {
    const msgs: readonly ChatMessage[] = [
      {
        id: 'work-run-run:task-9', kind: 'text', role: 'user',
        createdAt: 1000, turnStartedAt: 1000, text: 'recovered',
      },
    ];
    const next = applyWorkItem(
      msgs,
      {
        taskId: 'task-9', runId: 'run:task-9', turnId: undefined,
        kind: 'final', id: 'f9', at: 1100, conversationId: CONVERSATION_ID, text: 'done',
      },
    );
    const u = next.find((m) => m.kind === 'text' && m.role === 'user');
    expect(u?.kind === 'text' && u.finalElapsedMs).toBeUndefined();
  });
});

describe('work-item-mapper: command output routing (spec §6.4)', () => {
  const outputOf = (msgs: readonly ChatMessage[], toolId: string): string | undefined => {
    const t = msgs.find((m) => m.kind === 'tool' && m.id === toolId);
    return t?.kind === 'tool' ? t.outputText : undefined;
  };
  const activityOf = (msgs: readonly ChatMessage[]): string | undefined => {
    const c = msgs.find((m) => m.kind === 'thinking');
    return c?.kind === 'thinking' ? c.activity : undefined;
  };

  it('output with a matching toolCallId appends to that ToolCard, not the thinking card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1001));
    msgs = applyWorkItem(msgs, progress('cloning repo…', 1002, 's1'));
    expect(outputOf(msgs, 'tool-s1')).toBe('cloning repo…');
    expect(activityOf(msgs)).toBeUndefined();
  });

  it('sequential output segments append with newlines', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1001));
    msgs = applyWorkItem(msgs, progress('first line', 1002, 's1'));
    msgs = applyWorkItem(msgs, progress('second line', 1003, 's1'));
    expect(outputOf(msgs, 'tool-s1')).toBe('first line\nsecond line');
  });

  it('a replay of the same tail does not duplicate the segment', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1001));
    msgs = applyWorkItem(msgs, progress('same line', 1002, 's1'));
    const next = applyWorkItem(msgs, progress('same line', 1003, 's1'));
    expect(next).toBe(msgs);
    expect(outputOf(msgs, 'tool-s1')).toBe('same line');
  });

  it('output for a different tool goes to its own card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tool('s1', 'running', 1001));
    msgs = applyWorkItem(msgs, tool('s2', 'running', 1002));
    msgs = applyWorkItem(msgs, progress('from s2', 1003, 's2'));
    expect(outputOf(msgs, 'tool-s1')).toBeUndefined();
    expect(outputOf(msgs, 'tool-s2')).toBe('from s2');
  });

  it('output without a matching tool card degrades to the thinking activity line', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, thinking('reasoning', 1001));
    msgs = applyWorkItem(msgs, progress('orphaned output', 1002, 's9'));
    expect(outputOf(msgs, 'tool-s1')).toBeUndefined();
    expect(activityOf(msgs)).toBe('orphaned output');
    const card = msgs.find((m) => m.kind === 'thinking');
    expect(card?.kind === 'thinking' && card.preview).not.toContain('orphaned output');
  });
});

describe('work-item-mapper: approval cards (M4-E)', () => {
  const approvalItem = (
    status: 'pending' | 'approved' | 'denied',
    at: number,
    over: Record<string, unknown> = {},
  ): ConversationItem => ({
    ...IDENTITY,
    kind: 'approval',
    id: 'approval:run:task-1:ap-1',
    at,
    conversationId: CONVERSATION_ID,
    approvalId: 'ap-1',
    type: 'run_command',
    description: 'Run shell command: git push',
    status,
    ...over,
  });

  it('approval_requested appends a pending approval message', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, approvalItem('pending', 1001));
    const card = msgs.find((m) => m.kind === 'approval');
    expect(card?.kind === 'approval' && card.status).toBe('pending');
    expect(card?.kind === 'approval' && card.approvalId).toBe('ap-1');
  });

  it('approval_granted updates the SAME card instead of stacking a second', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, approvalItem('pending', 1001));
    msgs = applyWorkItem(msgs, approvalItem('approved', 1002));
    const cards = msgs.filter((m) => m.kind === 'approval');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind === 'approval' && cards[0].status).toBe('approved');
    // The follow-up carries no description; the original copy is kept.
    expect(cards[0]?.kind === 'approval' && cards[0].description).toBe(
      'Run shell command: git push',
    );
  });

  it('approval_denied updates the card to denied', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, approvalItem('pending', 1001));
    msgs = applyWorkItem(msgs, approvalItem('denied', 1002));
    const card = msgs.find((m) => m.kind === 'approval');
    expect(card?.kind === 'approval' && card.status).toBe('denied');
  });

  it('P3: pending Work approvals carry authority=work and forward the raw details', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    const details = { path: 'src/foo.ts', toolInput: { content: 'A' } };
    msgs = applyWorkItem(
      msgs,
      approvalItem('pending', 1001, { details }),
    );
    const card = msgs.find((m) => m.kind === 'approval');
    expect(card?.kind === 'approval' && card.authority).toBe('work');
    // P3 (spec §4.6): the raw upstream record is forwarded on
    // the item; the mapper attaches it to the message so the
    // safe preview parser can use it. The full record is NOT
    // meant for the persisted ConversationRecord, but the
    // mapper never re-shapes it on its own.
    expect((card as { details?: unknown } | undefined)?.details).toEqual(details);
  });
});

describe('work-item-mapper: input-request cards (M4-E)', () => {
  const questions = [
    {
      id: 'outcome',
      header: 'Outcome',
      question: 'What should the task deliver?',
      options: [
        { label: 'Report', description: 'Written report' },
        { label: 'No file', description: 'Answer only' },
      ],
    },
  ];
  const requestItem = (
    status: 'pending' | 'submitted' | 'dismissed',
    at: number,
    over: Record<string, unknown> = {},
  ): ConversationItem => ({
    ...IDENTITY,
    kind: 'input_request',
    id: 'input_request:run:task-1:ir-1',
    at,
    conversationId: CONVERSATION_ID,
    requestId: 'ir-1',
    questions,
    status,
    ...over,
  });

  it('input_request_created appends a pending input_request message with questions', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, requestItem('pending', 1001));
    const card = msgs.find((m) => m.kind === 'input_request');
    expect(card?.kind === 'input_request' && card.status).toBe('pending');
    expect(card?.kind === 'input_request' && card.questions).toHaveLength(1);
  });

  it('input_request_resolved updates the SAME card, keeping questions and adding answers', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, requestItem('pending', 1001));
    msgs = applyWorkItem(
      msgs,
      requestItem('submitted', 1002, {
        questions: [],
        answers: { outcome: { optionLabel: 'Report' } },
      }),
    );
    const cards = msgs.filter((m) => m.kind === 'input_request');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind === 'input_request' && cards[0].status).toBe('submitted');
    // The follow-up carries no questions; the pending card's are kept.
    expect(cards[0]?.kind === 'input_request' && cards[0].questions).toHaveLength(1);
    expect(cards[0]?.kind === 'input_request' && cards[0].answers).toEqual({
      outcome: { optionLabel: 'Report' },
    });
  });

  it('input_request_dismissed updates the card to dismissed', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, requestItem('pending', 1001));
    msgs = applyWorkItem(msgs, requestItem('dismissed', 1002));
    const card = msgs.find((m) => m.kind === 'input_request');
    expect(card?.kind === 'input_request' && card.status).toBe('dismissed');
  });
});

// ---------------------------------------------------------------------------
// 2026-09-01 (New direction): the task path shares Code's mature
// card UI — thinking/tool/plan/progress become ordinary cards, and
// the old PhaseRail (work_rail / work_narration / work_activity_group)
// is NOT produced. Only the deliverable projection stays Work-specific
// (generator facts + document/deck artifacts fold into it).
// ---------------------------------------------------------------------------

describe('work-item-mapper: task path (Code-card parity + deliverable)', () => {
  const TASK_IDENTITY = {
    taskId: 'task-1', runId: 'run:task-1', turnId: 'u1',
    conversationId: CONVERSATION_ID, intent: 'task',
  } as const;

  const tThinking = (text: string, at: number): ConversationItem => ({
    ...TASK_IDENTITY,
    kind: 'thinking', id: `th-${at}`, at, text,
  });
  const tTool = (
    stepId: string,
    status: 'running' | 'done' | 'error',
    at: number,
  ): ConversationItem => ({
    ...TASK_IDENTITY,
    kind: 'tool', id: `tool-${stepId}`, at,
    tool: 'read_file', summary: `read_file ${status}`, status,
    toolCallId: stepId,
  });
  const tFinal = (at: number, text: string): ConversationItem => ({
    ...TASK_IDENTITY,
    kind: 'final', id: 'f1', at, text,
  });

  it('task items render Code cards — no old PhaseRail / narration / activity / workflow (§4)', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tThinking('scanning repo', 1001));
    msgs = applyWorkItem(
      msgs,
      { ...TASK_IDENTITY, kind: 'plan', id: 'pl-1', at: 1002, stage: 'started', name: 'DISCOVER', text: 'DISCOVER' },
    );
    msgs = applyWorkItem(msgs, tTool('s1', 'running', 1003));
    msgs = applyWorkItem(msgs, tTool('s1', 'done', 1004));
    msgs = applyWorkItem(
      msgs,
      { ...TASK_IDENTITY, kind: 'progress', id: 'pr-1', at: 1005, text: 'reading notes.md' },
    );
    // thinking/tool become ordinary cards (Code parity)…
    const th = msgs.filter((m) => m.kind === 'thinking');
    expect(th).toHaveLength(1);
    expect(th[0]?.kind === 'thinking' && th[0].preview).toContain('scanning repo');
    expect(msgs.filter((m) => m.kind === 'tool')).toHaveLength(1);
    // …and the old heavy Work-only projection is gone.
    expect(msgs.filter((m) => m.kind === 'work_rail')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'work_narration')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'work_activity_group')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'workflow')).toHaveLength(0);
  });

  it('consecutive task thinking folds into ONE card (Code parity)', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tThinking('first thought', 1001));
    msgs = applyWorkItem(msgs, tThinking('second thought', 1002));
    const ts = msgs.filter((m) => m.kind === 'thinking');
    expect(ts).toHaveLength(1);
    const card = ts[0];
    expect(card?.kind === 'thinking' && card.preview).toContain('first thought');
    expect(card?.kind === 'thinking' && card.preview).toContain('second thought');
    // No narration rows are produced.
    expect(msgs.filter((m) => m.kind === 'work_narration')).toHaveLength(0);
  });

  it('task tools upsert per stepId into distinct ToolCards (no activity group)', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(msgs, tTool('s1', 'running', 1001));
    msgs = applyWorkItem(msgs, tTool('s1', 'done', 1600));
    msgs = applyWorkItem(msgs, tTool('s2', 'running', 1700));
    const tools = msgs.filter((m) => m.kind === 'tool');
    expect(tools).toHaveLength(2); // one per distinct step id
    expect(tools[0]?.kind === 'tool' && tools[0].status).toBe('done');
    expect(tools[1]?.kind === 'tool' && tools[1].status).toBe('running');
    expect(msgs.filter((m) => m.kind === 'work_activity_group')).toHaveLength(0);
  });

  it('decision cards and artifacts still render inline; deck artifacts fold into deliverable', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(
      msgs,
      {
        ...TASK_IDENTITY,
        kind: 'approval', id: 'approval:run:task-1:ap-1', at: 1001,
        approvalId: 'ap-1', type: 'run_command',
        description: 'Run shell command: git push', status: 'pending',
      },
    );
    msgs = applyWorkItem(
      msgs,
      { ...TASK_IDENTITY, kind: 'artifact', id: 'art-1', at: 1002, filePath: 'D:/repo/.trylo/out/deck.pptx', artifactKind: undefined },
    );
    expect(msgs.filter((m) => m.kind === 'approval')).toHaveLength(1);
    expect(msgs.filter((m) => m.kind === 'artifact')).toHaveLength(1);
    // The .pptx artifact also folds into the Work-specific deliverable panel.
    expect(msgs.filter((m) => m.kind === 'deliverable')).toHaveLength(1);
  });

  it('deliverable_fact renders the Work-specific deliverable panel — no chat card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(
      msgs,
      {
        ...TASK_IDENTITY,
        kind: 'deliverable_fact', id: 'df-1', at: 1001,
        fact: { type: 'tool_result', tool: 'generate_presentation', ok: true },
      },
    );
    expect(msgs.filter((m) => m.kind === 'deliverable')).toHaveLength(1);
    // deliverable_fact never leaks a raw card.
    expect(msgs.filter((m) => m.kind === 'tool')).toHaveLength(0);
  });

  it('terminal appends assistant text, freezes the timer and the thinking card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1', 1000)];
    msgs = applyWorkItem(msgs, tTool('s1', 'running', 1001));
    msgs = applyWorkItem(msgs, tFinal(2000, 'All done.'));
    const last = msgs[msgs.length - 1];
    expect(last?.kind === 'text' && last.role).toBe('assistant');
    expect(last?.kind === 'text' && last.text).toBe('All done.');
    const u = msgs.find((m) => m.kind === 'text' && m.role === 'user');
    expect(u?.kind === 'text' && u.finalElapsedMs).toBe(1000);
    const tool = msgs.find((m) => m.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.status).toBe('interrupted');
  });

  it('replaying the tail upserts tools in place — no duplicated tool cards', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    const items: readonly ConversationItem[] = [
      tTool('s1', 'running', 1002),
      tTool('s1', 'done', 1003),
    ];
    for (const item of items) msgs = applyWorkItem(msgs, item);
    for (const item of items) msgs = applyWorkItem(msgs, item);
    // Tools upsert by stable id — replay never stacks a second card.
    expect(msgs.filter((m) => m.kind === 'tool')).toHaveLength(1);
    expect(msgs.filter((m) => m.kind === 'work_rail')).toHaveLength(0);
  });
});

describe('work-item-mapper: intent boundaries (redesign spec §3.1)', () => {
  const CONV_IDENTITY = {
    taskId: 'task-2', runId: 'run:task-2', turnId: 'u1',
    conversationId: CONVERSATION_ID, intent: 'conversation',
  } as const;

  it('conversation turns answer content only — no PhaseRail, no workflow card', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(
      msgs,
      { ...CONV_IDENTITY, kind: 'thinking', id: 'th-1', at: 1001, text: 'Let me answer.' },
    );
    msgs = applyWorkItem(
      msgs,
      { ...CONV_IDENTITY, kind: 'plan', id: 'pl-1', at: 1002, stage: 'started', name: 'DISCOVER', text: 'DISCOVER' },
    );
    msgs = applyWorkItem(
      msgs,
      { ...CONV_IDENTITY, kind: 'final', id: 'f1', at: 1003, text: 'The answer is 42.' },
    );
    // Answer content renders.
    const final = msgs[msgs.length - 1];
    expect(final?.kind === 'text' && final.text).toBe('The answer is 42.');
    // But the task scaffolding never does.
    expect(msgs.filter((m) => m.kind === 'work_rail')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'work_narration')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'work_activity_group')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'workflow')).toHaveLength(0);
    // The durable transport still emits executor thinking/plan events for a
    // chat turn. They must remain diagnostics-only, not fall back to the old
    // ThinkingCard path (the screenshot regression).
    expect(msgs.filter((m) => m.kind === 'thinking')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'tool')).toHaveLength(0);
    expect(msgs).toHaveLength(2); // user + final answer only
  });

  it('legacy frames without an intent do not leak scaffolding (conversation semantics)', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    // LEGACY (no intent field) — recovered runs. Old records only
    // persisted taskId/turnId; the daemon's plan/thinking scaffolding
    // must NOT leak into the chat as bubbles.
    msgs = applyWorkItem(
      msgs,
      { ...LEGACY, conversationId: CONVERSATION_ID, kind: 'plan', id: 'pl-1', at: 1001, stage: 'started', name: 'DISCOVER', text: 'DISCOVER' },
    );
    expect(msgs.filter((m) => m.kind === 'workflow')).toHaveLength(0);
    expect(msgs.filter((m) => m.kind === 'work_rail')).toHaveLength(0);
    expect(msgs).toHaveLength(1); // user bubble only — plan hidden
  });

  it('legacy frames without an intent still render terminal content', () => {
    let msgs: readonly ChatMessage[] = [userMessage('u1')];
    msgs = applyWorkItem(
      msgs,
      { ...LEGACY, conversationId: CONVERSATION_ID, kind: 'final', id: 'f1', at: 1002, text: 'All done.' },
    );
    const last = msgs[msgs.length - 1];
    expect(last?.kind === 'text' && last.text).toBe('All done.');
  });
});
