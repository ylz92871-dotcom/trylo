// Trylo Desktop — Adapter parity tests (spec §11.1).
//
// Two adapters take semantically identical scenarios and
// must land on the SAME visible ChatMessage skeleton:
//   - Code  `applyEvents`   (LoopEvent → ChatMessage)
//   - Work  `applyWorkItem` (ConversationItem → ChatMessage)
//
// We run the same story through BOTH reducers (both start
// from `beginConversationTurn`, spec §6.1) and compare a
// structural projection of the output — kind/order/status —
// not the raw message objects, because the two vocabularies
// legitimately differ in bookkeeping (`turn` rows, plan
// wording, tool name casing). The projection below keeps
// only what the user actually sees: thinking cards, tool
// cards, assistant text and errors.
//
// Allowed differences (spec §11.1): capability-specific
// events like Work artifacts or Code compaction. Tool names
// are normalized through the §6.5 alias table so `Read` and
// `read_file` compare equal.

import { describe, expect, it } from 'vitest';
import { beginConversationTurn } from './types';
import { applyEvents } from './events';
import type { LoopEvent } from '../../host-adapter/loop-events';
import { applyWorkItem } from './work-item-mapper';
import type { ConversationItem } from '@trylo/work';
import type { ChatMessage, ToolMessage } from './types';

// ── §6.5 alias table: PascalCase (Code) vs snake_case
// ── (Work) collapse to one normalized kind. ──────────────
const TOOL_ALIAS: Record<string, string> = {
  Bash: 'bash', bash: 'bash', shell: 'bash', command: 'bash',
  Read: 'read', read: 'read', file_read: 'read', read_file: 'read',
  Edit: 'edit', edit: 'edit', patch: 'edit',
  Write: 'write', write: 'write',
  Grep: 'grep', grep: 'grep', search_text: 'grep',
  Glob: 'glob', glob: 'glob', list_files: 'glob',
  WebFetch: 'webfetch', webfetch: 'webfetch',
  WebSearch: 'websearch', websearch: 'websearch',
};
function normalizeTool(name: string): string {
  return TOOL_ALIAS[name] ?? name.toLowerCase();
}

/** The user-visible structural skeleton. Entries keep only
 *  what both adapters are supposed to agree on. */
type SkeletonEntry =
  | { kind: 'thinking' }
  | { kind: 'tool'; tool: string; status: string; outputText?: string }
  | { kind: 'text'; text: string }
  | { kind: 'error' };

function skeleton(msgs: readonly ChatMessage[]): SkeletonEntry[] {
  const out: SkeletonEntry[] = [];
  for (const m of msgs) {
    switch (m.kind) {
      case 'thinking':
        out.push({ kind: 'thinking' });
        break;
      case 'tool': {
        const t = m as ToolMessage;
        out.push({
          kind: 'tool',
          tool: normalizeTool(t.tool),
          status: t.status,
          // Code emits '' for a failed tool's (absent)
          // output; Work leaves it undefined. Both mean
          // "no output" — normalize before comparing.
          outputText: t.outputText === '' ? undefined : t.outputText,
        });
        break;
      }
      case 'text':
        if (m.role === 'assistant') out.push({ kind: 'text', text: m.text });
        break;
      case 'error':
        out.push({ kind: 'error' });
        break;
      default:
        // user / turn / notice / compaction are structural
        // or capability-specific — outside the visible
        // semantic skeleton (§11.1).
        break;
    }
  }
  return out;
}

const toWork = (items: readonly ConversationItem[], start: readonly ChatMessage[]) =>
  items.reduce((acc, item) => applyWorkItem(acc, item), start);
const toCode = (events: readonly LoopEvent[], start: readonly ChatMessage[]) =>
  applyEvents(start, events);

const USER = () => beginConversationTurn({ text: 'do it', turnId: 'u1', now: 1000 });

// ── shared fixture builders ──────────────────────────────
// 2026-09-01 (New direction): Work task runs reuse Code's card UI,
// so the Work fixtures carry `intent: 'task'` to exercise the shared
// (Code-parity) path. (Conversation/legacy intent-boundary behavior
// is covered separately in work-item-mapper.test.ts.)
const IDENTITY = { taskId: 'task-1', runId: 'run:task-1', turnId: 'u1', intent: 'task' } as const;
const CONV = 'conv-1';

const thinkingItem = (text: string, at: number, phaseId?: string): ConversationItem =>
  ({ ...IDENTITY, kind: 'thinking', id: `th-${at}`, at, conversationId: CONV, text, phaseId });
const toolItem = (
  stepId: string,
  status: 'running' | 'done' | 'error',
  at: number,
  phaseId?: string,
  tool: string = 'read_file',
): ConversationItem =>
  ({
    ...IDENTITY,
    kind: 'tool', id: `tool-${stepId}`, at, conversationId: CONV,
    tool, summary: `${tool} ${status}`, status,
    toolCallId: stepId, phaseId,
  });
const outputItem = (text: string, at: number, stepId: string): ConversationItem =>
  ({ ...IDENTITY, kind: 'progress', id: `pr-${at}`, at, conversationId: CONV, text, toolCallId: stepId });
const finalItem = (text: string, at: number): ConversationItem =>
  ({ ...IDENTITY, kind: 'final', id: `f-${at}`, at, conversationId: CONV, text });

const thinkingEvent = (summary: string, ts: number, partial = false): LoopEvent =>
  ({ type: 'thinking', seq: ts, ts, turn: 1, summary, preview: summary, fullLength: summary.length, partial });
const textEvent = (text: string, ts: number, partial = false): LoopEvent =>
  ({ type: 'text', seq: ts, ts, turn: 1, preview: text, fullText: text, partial });
const toolUseEvent = (id: string, tool: string, ts: number, input: Record<string, unknown> = {}): LoopEvent =>
  ({ type: 'tool_use', seq: ts, ts, turn: 1, id, tool, input });
const toolResultEvent = (
  id: string, tool: string, ok: boolean, output: string, ts: number, durationMs = 100,
): LoopEvent =>
  ({ type: 'tool_result', seq: ts, ts, turn: 1, id, tool, ok, output, durationMs });

describe('Adapter parity: user → thinking → final (§11.1)', () => {
  it('Code and Work land on the same visible skeleton', () => {
    const code = toCode(
      [thinkingEvent('Analyzing the request', 1010), textEvent('Here is the answer.', 1050)],
      [USER()],
    );
    const work = toWork(
      [thinkingItem('Analyzing the request', 1010), finalItem('Here is the answer.', 1050)],
      [USER()],
    );
    expect(skeleton(code)).toEqual(skeleton(work));
    expect(skeleton(code)).toEqual([
      { kind: 'thinking' },
      { kind: 'text', text: 'Here is the answer.' },
    ]);
  });

  it('Code freezes at first output; Work counts until terminal (2026-08-28)', () => {
    const code = toCode([thinkingEvent('first output', 1010)], [USER()]);
    const work = toWork([thinkingItem('first output', 1010)], [USER()]);
    const codeUser = code.find((m) => m.kind === 'text' && m.role === 'user');
    const workUser = work.find((m) => m.kind === 'text' && m.role === 'user');
    expect(codeUser?.kind === 'text' && codeUser.finalElapsedMs).toBe(10);
    // Work's plan/thinking markers arrive within the first
    // second — freezing there made the counter never count
    // (user: "Work 不会计时"). Work freezes at terminal with
    // the FULL run duration instead.
    expect(workUser?.kind === 'text' && workUser.finalElapsedMs).toBeUndefined();
    const workDone = toWork([finalItem('done.', 2000)], work);
    const workDoneUser = workDone.find((m) => m.kind === 'text' && m.role === 'user');
    expect(workDoneUser?.kind === 'text' && workDoneUser.finalElapsedMs).toBe(1000);
  });
});

describe('Adapter parity: tool running → output → done → final (§11.1)', () => {
  it('Code and Work agree on tool status, output and duration', () => {
    const code = toCode(
      [
        thinkingEvent('reasoning', 1005),
        toolUseEvent('tu1', 'Read', 1010, { file_path: 'a.ts' }),
        toolResultEvent('tu1', 'Read', true, 'file content', 1610, 600),
        textEvent('All done.', 1700),
      ],
      [USER()],
    );
    const work = toWork(
      [
        thinkingItem('reasoning', 1005),
        toolItem('s1', 'running', 1010),
        outputItem('file content', 1100, 's1'),
        toolItem('s1', 'done', 1610),
        finalItem('All done.', 1700),
      ],
      [USER()],
    );
    // Both reduce the SAME visible story.
    expect(skeleton(code)).toEqual(skeleton(work));
    // And the tool card carries the same shape.
    const codeTool = code.find((m) => m.kind === 'tool') as ToolMessage | undefined;
    const workTool = work.find((m) => m.kind === 'tool') as ToolMessage | undefined;
    expect(codeTool?.status).toBe('done');
    expect(workTool?.status).toBe('done');
    expect(normalizeTool(codeTool?.tool ?? '')).toBe(normalizeTool(workTool?.tool ?? ''));
    expect(codeTool?.outputText).toBe('file content');
    expect(workTool?.outputText).toBe('file content');
    expect(codeTool?.durationMs).toBe(600);
    expect(workTool?.durationMs).toBe(600);
  });

  it('while the tool runs, both adapters show one running tool (intermediate state)', () => {
    const codeMid = toCode([thinkingEvent('reasoning', 1005), toolUseEvent('tu1', 'Read', 1010, {})], [USER()]);
    const workMid = toWork([thinkingItem('reasoning', 1005), toolItem('s1', 'running', 1010)], [USER()]);
    expect(skeleton(codeMid)).toEqual(skeleton(workMid));
    expect(skeleton(codeMid)).toContainEqual({ kind: 'tool', tool: 'read', status: 'running' });
  });
});

describe('Adapter parity: two thinking phases with two tools between (§11.1)', () => {
  it('both adapters produce phase1 → tool, tool → phase2 in the same order', () => {
    const code = toCode(
      [
        thinkingEvent('scanning', 1000),
        toolUseEvent('tu1', 'Read', 1010, { file_path: 'a.ts' }),
        toolResultEvent('tu1', 'Read', true, 'content A', 1210, 200),
        toolUseEvent('tu2', 'Bash', 1220, { command: 'ls' }),
        toolResultEvent('tu2', 'Bash', true, 'content B', 1320, 100),
        thinkingEvent('drafting', 1400),
      ],
      [USER()],
    );
    const work = toWork(
      [
        thinkingItem('scanning', 1000, 'g1'),
        toolItem('s1', 'running', 1010, 'g1'),
        outputItem('content A', 1100, 's1'),
        toolItem('s1', 'done', 1210, 'g1'),
        toolItem('s2', 'running', 1220, 'g1', 'bash'),
        outputItem('content B', 1230, 's2'),
        toolItem('s2', 'done', 1320, 'g1', 'bash'),
        thinkingItem('drafting', 1400, 'g2'),
      ],
      [USER()],
    );
    expect(skeleton(code)).toEqual(skeleton(work));
    expect(skeleton(code)).toEqual([
      { kind: 'thinking' },
      { kind: 'tool', tool: 'read', status: 'done', outputText: 'content A' },
      { kind: 'tool', tool: 'bash', status: 'done', outputText: 'content B' },
      { kind: 'thinking' },
    ]);
  });

  it('both adapters group the phase-1 tools under the SAME phaseId and split phase 2 (spec §6.3)', () => {
    const code = toCode(
      [
        thinkingEvent('scanning', 1000),
        toolUseEvent('tu1', 'Read', 1010, {}),
        toolResultEvent('tu1', 'Read', true, 'a', 1100, 90),
        toolUseEvent('tu2', 'Bash', 1110, {}),
        toolResultEvent('tu2', 'Bash', true, 'b', 1200, 90),
        thinkingEvent('drafting', 1300),
      ],
      [USER()],
    );
    const work = toWork(
      [
        thinkingItem('scanning', 1000, 'g1'),
        toolItem('s1', 'running', 1010, 'g1'),
        toolItem('s1', 'done', 1100, 'g1'),
        toolItem('s2', 'running', 1110, 'g1', 'bash'),
        toolItem('s2', 'done', 1200, 'g1', 'bash'),
        thinkingItem('drafting', 1300, 'g2'),
      ],
      [USER()],
    );
    for (const msgs of [code, work]) {
      const [t1, t2] = msgs.filter((m) => m.kind === 'tool');
      const [th1, th2] = msgs.filter((m) => m.kind === 'thinking');
      // Both phase-1 tools inherit the phase of their thinking.
      expect(t1?.kind === 'tool' && t1.phaseId).toBe(th1?.kind === 'thinking' ? th1.phaseId : undefined);
      expect(t2?.kind === 'tool' && t2.phaseId).toBe(th1?.kind === 'thinking' ? th1.phaseId : undefined);
      // Phase 2 is a different phase, and both tools share phase 1.
      expect(th2?.kind === 'thinking' && th2.phaseId).not.toBe(th1?.kind === 'thinking' ? th1.phaseId : undefined);
    }
  });
});

describe('Adapter parity: tool error (§11.1)', () => {
  it('Code and Work both surface a failed tool with status error', () => {
    const code = toCode(
      [
        thinkingEvent('reasoning', 1000),
        toolUseEvent('tu1', 'Read', 1010, { file_path: 'a.ts' }),
        toolResultEvent('tu1', 'Read', false, '', 1100, 90),
      ],
      [USER()],
    );
    const work = toWork(
      [
        thinkingItem('reasoning', 1000),
        toolItem('s1', 'running', 1010),
        toolItem('s1', 'error', 1100),
      ],
      [USER()],
    );
    expect(skeleton(code)).toEqual(skeleton(work));
    expect(skeleton(code)).toContainEqual({ kind: 'tool', tool: 'read', status: 'error' });
  });
});

describe('Adapter terminal rules (§6.6 / §11.1 run failed + cancelled)', () => {
  it('after a terminal both adapters have no partial thinking and no running tool', () => {
    // Code: the model finished thinking then the loop ended.
    const code = toCode(
      [
        thinkingEvent('final reasoning', 1000, false),
        toolUseEvent('tu1', 'Read', 1010, {}),
        toolResultEvent('tu1', 'Read', true, 'ok', 1100, 90),
        { type: 'loop_end', seq: 1200, ts: 1200, durationMs: 200, totalCost: 0, numTurns: 1, reason: 'end_turn', finalResult: 'ok' },
      ],
      [USER()],
    );
    // Work: the daemon reported failure.
    const work = toWork(
      [
        thinkingItem('final reasoning', 1000),
        toolItem('s1', 'running', 1010),
        toolItem('s1', 'done', 1100),
        { ...IDENTITY, kind: 'error', id: 'e1', at: 1200, conversationId: CONV, userMessage: 'Completion blocked', diagnosticId: 'diag-9' },
      ],
      [USER()],
    );
    for (const msgs of [code, work]) {
      const partialThinking = msgs.find((m) => m.kind === 'thinking' && m.partial);
      const runningTool = msgs.find((m) => m.kind === 'tool' && m.status === 'running');
      expect(partialThinking).toBeUndefined();
      expect(runningTool).toBeUndefined();
    }
    // The failure is visible in both: Work via an error item,
    // Code via the (view-state driven) run end — the error
    // vocabulary differs, but the frozen visible state agrees.
    expect(skeleton(work)).toContainEqual({ kind: 'error' });
  });

  it('a cancelled Work run flips running tools to interrupted and emits ONE system row', () => {
    let work = toWork(
      [
        thinkingItem('reasoning', 1000),
        toolItem('s1', 'running', 1010),
        { ...IDENTITY, kind: 'cancelled', id: 'c1', at: 1200, conversationId: CONV, text: 'Run cancelled' },
      ],
      [USER()],
    );
    const tools = work.filter((m) => m.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.kind === 'tool' && tools[0].status).toBe('interrupted');
    const terminal = work.filter((m) => m.kind === 'text' && m.role === 'system' && m.text === 'Run cancelled');
    expect(terminal).toHaveLength(1);
    // The cancelled row is emitted exactly once even if the
    // terminal item is replayed (spec §11.2 "恰好一次").
    work = applyWorkItem(work, {
      ...IDENTITY, kind: 'cancelled', id: 'c2', at: 1200, conversationId: CONV, text: 'Run cancelled',
    });
    const terminalAfterReplay = work.filter((m) => m.kind === 'text' && m.role === 'system' && m.text === 'Run cancelled');
    expect(terminalAfterReplay).toHaveLength(1);
  });
});
