import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage } from '../components/chat/types';
import {
  archiveConversation,
  createConversation,
  deleteConversation,
  emptyWorkspaceHistory,
  ensureConversation,
  flushAllPendingSaves,
  forceFlushHistory,
  listConversationSessions,
  loadWorkspaceHistory,
  normalizeWorkAttachments,
  normalizeWorkspaceHistory,
  renameConversation,
  scheduleWorkspaceHistorySave,
  selectConversation,
  unarchiveConversation,
  updateConversationAttachments,
  updateConversationMessages,
  workspaceKey,
} from './conversation-history';
import type { WorkspaceConversationHistory } from './conversation-history';
import type { FilePath } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => window.localStorage.clear());

function user(id: string, text: string, createdAt: number): ChatMessage {
  return { id, kind: 'text', role: 'user', text, createdAt };
}

describe('conversation history', () => {
  it('keeps Code and Work conversations side by side', () => {
    const code = createConversation(emptyWorkspaceHistory(), {
      kind: 'code', codeMode: 'agent', now: 100,
    });
    const work = createConversation(code.history, { kind: 'work', now: 200 });

    expect(work.history.activeByKind.code).toBe(code.session.id);
    expect(work.history.activeByKind.work).toBe(work.session.id);
    expect(listConversationSessions(work.history).map((session) => session.kind)).toEqual([
      'work', 'code',
    ]);
  });

  it('uses the first user prompt as title and counts user turns', () => {
    const created = createConversation(emptyWorkspaceHistory(), {
      kind: 'code', now: 100,
    });
    const history = updateConversationMessages(created.history, created.session.id, [
      user('u1', 'Fix the project history', 101),
      { id: 'a1', kind: 'text', role: 'assistant', text: 'Okay', createdAt: 102 },
      user('u2', 'Also preserve drafts', 103),
    ], 104);
    const session = history.conversations[created.session.id]!.session;

    expect(session.title).toBe('Fix the project history');
    expect(session.turnCount).toBe(2);
    expect(session.updatedAt).toBe(104);
  });

  it('selects and deletes independently inside each kind', () => {
    const first = createConversation(emptyWorkspaceHistory(), { kind: 'code', now: 100 });
    const second = createConversation(first.history, { kind: 'code', now: 200 });
    const work = createConversation(second.history, { kind: 'work', now: 300 });
    const selected = selectConversation(work.history, first.session.id);
    const deleted = deleteConversation(selected, first.session.id);

    expect(deleted.activeByKind.code).toBe(second.session.id);
    expect(deleted.activeByKind.work).toBe(work.session.id);
    expect(deleted.conversations[first.session.id]).toBeUndefined();
  });

  it('repairs invalid active pointers and missing kinds', () => {
    const history = normalizeWorkspaceHistory({
      conversations: {
        legacy: {
          session: {
            id: 'legacy', title: 'Legacy', mode: 'office',
            createdAt: 1, updatedAt: 2, turnCount: 0,
          },
          messages: [],
        },
      },
      activeByKind: { work: 'missing' },
    });
    expect(history.conversations.legacy?.session.kind).toBe('work');
    expect(history.activeByKind.work).toBe('legacy');
    expect(ensureConversation(history, 'code').activeByKind.code).not.toBeNull();
  });

  it('migrates legacy per-workspace sessions in browser mode', async () => {
    const root = 'D:/CC/project';
    window.localStorage.setItem('trylo:workspace-sessions:v1', JSON.stringify({
      workspaces: {
        [root]: [{
          id: 'old-code', title: 'Old code', mode: 'agent',
          createdAt: 1, updatedAt: 2, turnCount: 3,
        }],
      },
      active: { [root]: 'old-code' },
    }));

    const history = await loadWorkspaceHistory(root as FilePath);
    expect(history.activeByKind.code).toBe('old-code');
    expect(history.conversations['old-code']?.session.kind).toBe('code');
  });

  it('normalizes Windows workspace keys', () => {
    expect(workspaceKey('C:\\work\\DEMO-WS\\')).toBe('c:/work/demo-ws');
  });
});

describe('session archive / rename (2026-09-06)', () => {
  function seededHistory(): WorkspaceConversationHistory {
    const first = createConversation(emptyWorkspaceHistory(), { kind: 'code', now: 100 });
    const second = createConversation(first.history, { kind: 'code', now: 200 });
    return selectConversation(second.history, first.session.id);
  }

  it('archiveConversation stamps archivedAt and clears the active pointer for that kind', () => {
    const history = seededHistory();
    const archivedId = history.activeByKind.code!;
    const next = archiveConversation(history, archivedId, 123);

    expect(next.conversations[archivedId]!.session.archivedAt).toBe(123);
    // Active pointer is moved to the most-recent non-archived same-kind
    // session so the user lands on the next live conversation.
    expect(next.activeByKind.code).not.toBeNull();
    expect(next.activeByKind.code).not.toBe(archivedId);
  });

  it('archiving the ONLY conversation of a kind yields a fresh active session (never the archived one)', () => {
    const only = createConversation(emptyWorkspaceHistory(), { kind: 'code', now: 100 });
    const activeId = only.history.activeByKind.code!;
    const next = archiveConversation(only.history, activeId, 200);

    // The archived conversation must not silently remain active (it was
    // the newest by updatedAt when the pointer was repaired). If every
    // conversation of the kind is archived, the user must land on a NEW
    // live conversation, otherwise the main surface shows an invisible
    // session and sends appear dead.
    expect(next.activeByKind.code).not.toBeNull();
    expect(next.activeByKind.code).not.toBe(activeId);
    expect(next.conversations[next.activeByKind.code!]!.session.archivedAt).toBeUndefined();
  });

  it('a stale active pointer at an archived conversation is repaired on load', () => {
    const first = createConversation(emptyWorkspaceHistory(), { kind: 'code', now: 100 });
    const second = createConversation(first.history, { kind: 'code', now: 200 });
    // Simulate a dirty persisted file: active points at the archived row.
    const dirty = archiveConversation(second.history, second.session.id, 300);
    const handEdited = {
      ...dirty,
      activeByKind: { ...dirty.activeByKind, code: second.session.id },
    };
    const repaired = normalizeWorkspaceHistory(handEdited);
    expect(repaired.activeByKind.code).not.toBe(second.session.id);
    expect(repaired.conversations[repaired.activeByKind.code!]!.session.archivedAt).toBeUndefined();
  });

  it('archiveConversation is a no-op when the session is already archived', () => {
    const history = seededHistory();
    const archivedId = history.activeByKind.code!;
    const first = archiveConversation(history, archivedId, 100);
    const second = archiveConversation(first, archivedId, 200);
    expect(second).toBe(first);
    expect(second.conversations[archivedId]!.session.archivedAt).toBe(100);
  });

  it('unarchiveConversation clears archivedAt and bumps updatedAt', () => {
    const history = seededHistory();
    const archivedId = history.activeByKind.code!;
    const archived = archiveConversation(history, archivedId, 100);
    const restored = unarchiveConversation(archived, archivedId, 999);

    expect(restored.conversations[archivedId]!.session.archivedAt).toBeUndefined();
    expect(restored.conversations[archivedId]!.session.updatedAt).toBe(999);
  });

  it('renameConversation trims and writes the title; empty trims are no-ops', () => {
    const history = seededHistory();
    const id = history.activeByKind.code!;
    const renamed = renameConversation(history, id, '  New label  ');
    expect(renamed.conversations[id]!.session.title).toBe('New label');

    const blank = renameConversation(renamed, id, '   ');
    expect(blank).toBe(renamed); // unchanged ref ⇒ no-op

    const unchanged = renameConversation(renamed, id, 'New label');
    expect(unchanged).toBe(renamed); // identical title ⇒ no-op
  });

  it('archivedAt survives a save/reload round trip via the normalizer', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    (invoke as ReturnType<typeof vi.fn>).mockReset();
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const root = 'C:/work/demo-ws' as FilePath;
    const seed = seededHistory();
    const archivedId = seed.activeByKind.code!;
    const archived = archiveConversation(seed, archivedId, 444);
    await forceFlushHistory(root, archived);
    const reloaded = await loadWorkspaceHistory(root);
    expect(reloaded.conversations[archivedId]!.session.archivedAt).toBe(444);
  });
});

describe('M4-C history write-behind (spec §7.4)', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    (invoke as ReturnType<typeof vi.fn>).mockReset();
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  const root = 'C:/work/demo-ws' as FilePath;

  function seededHistory(): WorkspaceConversationHistory {
    const created = createConversation(emptyWorkspaceHistory(), { kind: 'code', now: 100 });
    return updateConversationMessages(created.history, created.session.id, [
      user('u1', 'confirmed user message', 101),
      { id: 'a1', kind: 'text', role: 'assistant', text: 'Ok', createdAt: 102 },
    ], 103);
  }

  function saveCalls(): Array<{ workspaceRoot: string; json: string }> {
    return (invoke as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'conversation_history_save')
      .map((call: unknown[]) => call[1] as { workspaceRoot: string; json: string });
  }

  it('terminal force flush writes a scheduled-but-unfired snapshot', async () => {
    scheduleWorkspaceHistorySave(root, seededHistory());
    expect(saveCalls()).toHaveLength(0); // debounce not fired yet
    await forceFlushHistory(root);
    expect(saveCalls()).toHaveLength(1);
    expect(saveCalls()[0]!.workspaceRoot).toBe(root);
  });

  it('collapses 100 stream deltas into far fewer than 100 disk writes', async () => {
    let current = seededHistory();
    for (let i = 0; i < 100; i += 1) {
      scheduleWorkspaceHistorySave(root, current, 30);
      current = updateConversationMessages(current, Object.keys(current.conversations)[0]!, [], Date.now() + i);
    }
    await forceFlushHistory(root, current);
    expect(saveCalls().length).toBeLessThan(10);
  });

  it('merges pending and never lets a stale snapshot overwrite a newer one', async () => {
    const v1 = seededHistory();
    scheduleWorkspaceHistorySave(root, v1, 10);
    // A fresher snapshot lands while the debounce is still pending.
    const v2 = updateConversationMessages(v1, Object.keys(v1.conversations)[0]!, [
      ...v1.conversations[Object.keys(v1.conversations)[0]!]!.messages,
      user('u2', 'second turn', 110),
      { id: 'a2', kind: 'text', role: 'assistant', text: 'ok', createdAt: 111 },
    ], 112);
    await forceFlushHistory(root, v2);
    expect(saveCalls()).toHaveLength(1);
    const written = JSON.parse(saveCalls()[0]!.json) as WorkspaceConversationHistory;
    const conversation = Object.values(written.conversations)[0]!;
    expect(conversation.messages.some((message) => message.id === 'u2')).toBe(true);
  });

  it('crash recovery does not lose a confirmed user message', async () => {
    const lastConfirmed = seededHistory();
    // A turn acked the message but the 300ms write-behind never fired before the crash.
    await forceFlushHistory(root, lastConfirmed);
    const reloaded = await loadWorkspaceHistory(root);
    const messages = Object.values(reloaded.conversations).flatMap((record) => record.messages);
    expect(messages.some((message) => message.kind === 'text' && message.role === 'user' && message.text === 'confirmed user message')).toBe(true);
  });

  it('flush-all flushes every pending workspace on exit', async () => {
    const otherRoot = 'D:/CC/other' as FilePath;
    const first = createConversation(emptyWorkspaceHistory(), { kind: 'code', now: 1 });
    const second = createConversation(emptyWorkspaceHistory(), { kind: 'work', now: 2 });
    scheduleWorkspaceHistorySave(root, first.history);
    scheduleWorkspaceHistorySave(otherRoot, second.history);
    expect(saveCalls()).toHaveLength(0);
    await flushAllPendingSaves();
    const roots = saveCalls().map((call) => call.workspaceRoot);
    expect(roots).toContain(root);
    expect(roots).toContain(otherRoot);
    expect(roots.length).toBeGreaterThanOrEqual(2);
  });
});

// P2-1 Work Package B: Work attachment metadata persistence.
describe('work attachment metadata (Work Package B)', () => {
  const root = 'C:/work/demo-ws' as FilePath;
  const validRecord = {
    id: 'att_1',
    name: 'spec.md',
    relativePath: '.trylo/attachments/conv-1/att_1/spec.md',
    mediaType: 'text/markdown',
    size: 512,
  };

  function workHistory(): { history: WorkspaceConversationHistory; workId: string; codeId: string } {
    const code = createConversation(emptyWorkspaceHistory(), { kind: 'code', now: 100 });
    const work = createConversation(code.history, { kind: 'work', now: 200 });
    return { history: work.history, workId: work.session.id, codeId: code.session.id };
  }

  it('normalizeWorkAttachments keeps only whitelisted, staging-contained records', () => {
    const normalized = normalizeWorkAttachments([
      validRecord,
      { ...validRecord, id: 'att_2', relativePath: 'D:/outside/secret.md' }, // absolute
      { ...validRecord, id: 'att_3', relativePath: '.trylo/attachments/../conversations.v1.json' }, // traversal
      { ...validRecord, id: '', name: 'x.md' }, // empty id
      { ...validRecord, id: 'att_5', size: -1 }, // negative size
      { ...validRecord, id: 'att_6', size: Number.NaN }, // non-finite
      { name: 'no-id.md' }, // missing id
      'garbage',
      null,
    ]);
    expect(normalized).toEqual([validRecord]);
  });

  it('normalizeWorkAttachments returns undefined for empty / non-array input', () => {
    expect(normalizeWorkAttachments(undefined)).toBeUndefined();
    expect(normalizeWorkAttachments([])).toBeUndefined();
    expect(normalizeWorkAttachments('nope')).toBeUndefined();
    expect(normalizeWorkAttachments({ })).toBeUndefined();
  });

  it('updateConversationAttachments stores normalized metadata on a work conversation', () => {
    const { history, workId } = workHistory();
    const next = updateConversationAttachments(history, workId, [validRecord]);
    expect(next.conversations[workId]!.attachments).toEqual([validRecord]);
  });

  it('updateConversationAttachments never touches code conversations', () => {
    const { history, codeId } = workHistory();
    const next = updateConversationAttachments(history, codeId, [validRecord]);
    expect(next).toBe(history);
    expect(next.conversations[codeId]!.attachments).toBeUndefined();
  });

  it('updateConversationAttachments with undefined clears the field', () => {
    const { history, workId } = workHistory();
    const seeded = updateConversationAttachments(history, workId, [validRecord]);
    const cleared = updateConversationAttachments(seeded, workId, undefined);
    expect(cleared.conversations[workId]!.attachments).toBeUndefined();
    expect('attachments' in cleared.conversations[workId]!).toBe(false);
  });

  it('attachment metadata survives a save/reload round trip', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    (invoke as ReturnType<typeof vi.fn>).mockReset();
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { history, workId } = workHistory();
    const seeded = updateConversationAttachments(history, workId, [validRecord]);
    await forceFlushHistory(root, seeded);
    const reloaded = await loadWorkspaceHistory(root);
    expect(reloaded.conversations[workId]!.attachments).toEqual([validRecord]);
  });

  it('old history files without the attachments field load unchanged', () => {
    const { history, workId } = workHistory();
    const raw = JSON.parse(JSON.stringify(history)) as Record<string, unknown>;
    const normalized = normalizeWorkspaceHistory(raw);
    expect(normalized.conversations[workId]!.attachments).toBeUndefined();
  });

  it('hostile persisted attachment records are dropped on load', () => {
    const { history, workId } = workHistory();
    const raw = JSON.parse(JSON.stringify(history)) as {
      conversations: Record<string, Record<string, unknown>>;
    };
    raw.conversations[workId]!.attachments = [
      validRecord,
      { ...validRecord, id: 'evil', relativePath: '../../etc/passwd' },
    ];
    const normalized = normalizeWorkspaceHistory(raw);
    expect(normalized.conversations[workId]!.attachments).toEqual([validRecord]);
  });
});

// ── 2026-09-06: compaction-flood cleanup ──
// A persisted conversation can hold hundreds of byte-identical "context
// compacted" pills (a single compaction amplified into a run by replay/resume).
// On load, rows sharing a (tokensBefore, tokensAfter, reason) tuple collapse to
// the first occurrence, mirroring applyCompact's live identical-redelivery guard.

describe('conversation history: compaction-flood dedupe on load', () => {
  const rawWithFlood = (): { conversations: Record<string, Record<string, unknown>> } => ({
    conversations: {
      c1: {
        session: {
          id: 'c1', title: 'Flooded', mode: 'office',
          createdAt: 1, updatedAt: 2, turnCount: 0,
        },
        messages: [
          { id: 'm1', kind: 'compaction', role: 'system', createdAt: 100, reason: 'auto', tokensBefore: 168000, tokensAfter: 3400 },
          // byte-identical replay of m1 → must collapse
          { id: 'm2', kind: 'compaction', role: 'system', createdAt: 130, reason: 'auto', tokensBefore: 168000, tokensAfter: 3400 },
          { id: 'm3', kind: 'text', role: 'user', text: 'hi', createdAt: 140 },
          // old boundary with no token counts; its replay is a duplicate too
          { id: 'm4', kind: 'compaction', role: 'system', createdAt: 160, reason: 'auto' },
          { id: 'm5', kind: 'compaction', role: 'system', createdAt: 190, reason: 'auto' },
          // a genuine second compaction reports grown numbers → kept
          { id: 'm6', kind: 'compaction', role: 'system', createdAt: 220, reason: 'auto', tokensBefore: 96000, tokensAfter: 4100 },
        ],
      },
    },
  });

  it('keeps one pill per distinct token-count tuple, dropping the flood', () => {
    const normalized = normalizeWorkspaceHistory(rawWithFlood());
    const compactions = normalized.conversations.c1!.messages.filter(
      (m) => m.kind === 'compaction',
    );
    expect(compactions.map((m) => m.id)).toEqual(['m1', 'm4', 'm6']);
    expect(normalized.conversations.c1!.messages.map((m) => m.id)).toEqual(['m1', 'm3', 'm4', 'm6']);
  });

  it('keeps distinct reasons as separate pills', () => {
    const raw = rawWithFlood();
    raw.conversations.c1!.messages = [
      { id: 'a', kind: 'compaction', role: 'system', createdAt: 100, reason: 'auto', tokensBefore: 168000, tokensAfter: 3400 },
      { id: 'b', kind: 'compaction', role: 'system', createdAt: 130, reason: 'manual', tokensBefore: 168000, tokensAfter: 3400 },
    ];
    const normalized = normalizeWorkspaceHistory(raw);
    const compactions = normalized.conversations.c1!.messages.filter(
      (m) => m.kind === 'compaction',
    );
    expect(compactions.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

// ── PR-4 (spec §7.2 / §12.2): ToolMessage migration + BinaryRef-only persistence ──

describe('conversation history: PR-4 tool-result migration', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const REF = {
    id: 'bin-1', storage: 'ephemeral-tool-cache',
    path: 'C:/appdata/tool-cache/aa/aa11.png', mimeType: 'image/png',
    size: 100, sha256: 'a'.repeat(64),
  };

  function historyWithMessages(messages: unknown) {
    return normalizeWorkspaceHistory({
      conversations: {
        c1: {
          session: { id: 'c1', kind: 'code', createdAt: 1, updatedAt: 1 },
          messages,
          draft: '',
        },
      },
    });
  }

  it('migrates the legacy `output: string` shape to outputText (old sessions stay readable)', () => {
    const history = historyWithMessages([
      { id: 't1', kind: 'tool', role: 'assistant', createdAt: 5, tool: 'Bash', status: 'done', summary: 'ls', output: 'file list' },
    ]);
    const tool = history.conversations['c1']!.messages.find((m) => m.kind === 'tool') as unknown as Record<string, unknown>;
    expect(tool['outputText']).toBe('file list');
    expect(tool['output']).toBeUndefined();
  });

  it('round-trips BinaryRef metadata through normalize (metadata persists, bytes do not)', () => {
    const history = historyWithMessages([
      {
        id: 't1', kind: 'tool', role: 'assistant', createdAt: 5, tool: 'shot', status: 'done', summary: 's',
        outputText: 'shot', outputContent: [{ type: 'image', ref: REF }],
      },
    ]);
    const tool = history.conversations['c1']!.messages.find((m) => m.kind === 'tool') as unknown as Record<string, unknown>;
    expect(tool['outputContent']).toEqual([{ type: 'image', ref: REF }]);
    expect(JSON.stringify(history)).not.toContain('iVBOR');
  });

  it('strips inline base64 / blob fields from a (tampered) history file before they re-enter state', () => {
    // A bulk (>512-char) base64 payload — the size below which ordinary
    // alphanumerics are NOT mistaken for base64 (heuristic threshold).
    const bulk = (PNG + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=').repeat(5);
    const history = historyWithMessages([
      {
        id: 't1', kind: 'tool', role: 'assistant', createdAt: 5, tool: 'shot', status: 'done', summary: 's',
        outputContent: [{ type: 'image', blob: PNG }, { type: 'text', text: bulk }],
      },
    ]);
    const tool = history.conversations['c1']!.messages.find((m) => m.kind === 'tool') as unknown as Record<string, unknown>;
    // The text-block sanitizer replaces base64 text with a notice; the
    // blob block is dropped outright. Either way: no base64 re-enters.
    expect(tool['outputContent']).toEqual([
      { type: 'text', text: '[binary content removed from the session record]' },
    ]);
    expect(JSON.stringify(history)).not.toContain('iVBOR');
    expect(JSON.stringify(history)).not.toContain('QUJDREVGR0hJSktMTU5P');
  });

  it('emits history version 2 (PR-4 shape) and still accepts version-1 files', () => {
    const fresh = normalizeWorkspaceHistory(emptyWorkspaceHistory());
    expect(fresh.version).toBe(2);
    const legacy = historyWithMessages([
      { id: 't1', kind: 'tool', role: 'assistant', createdAt: 5, tool: 'Bash', status: 'done', summary: 'ls', output: 'x' },
    ]);
    expect(legacy.version).toBe(2);
    expect(legacy.conversations['c1']).toBeDefined();
  });
});
