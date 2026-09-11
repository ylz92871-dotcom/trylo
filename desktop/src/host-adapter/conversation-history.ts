import { invoke } from '@tauri-apps/api/core';
import {
  bindManagedChild,
  deserializeManagedChildBindings,
  type ManagedChildBindings,
} from '../managed-work/managed-child-binding';
import type { ManagedChildBinding } from '../managed-work/managedWorkTypes';
import type { ChatMessage, ToolMessage } from '../components/chat/types';
import type { CodeMode, FilePath, TopLevelMode } from './types';
import type { TryloMode, TryloSession } from './trylo-api';
import type { StoredConversationResults } from '../results/conversation-result-types';
import { normalizeConversationResults } from '../results/conversation-result-normalizer';
import { normalizePersistedToolResultContent } from '../tooling/tool-result-content';
import { isTauri } from './tauri-detect';

export type ConversationKind = TopLevelMode;

export interface ConversationSession extends TryloSession {
  readonly kind: ConversationKind;
  readonly codeMode?: CodeMode;
  /** 2026-09-06: wall-clock time the user archived this conversation,
   *  or `undefined` for live sessions. Soft-delete — the messages
   *  are kept so un-archive restores the exact transcript. The rail
   *  hides archived sessions behind a disclosure (see LeftRail). */
  readonly archivedAt?: number;
}

/** P2-1 Work Package B: persisted Work attachment metadata. The staged
 *  file itself lives on disk at `<workspace>/<relativePath>`; on load
 *  the attachment store re-validates each file via statFile and drops
 *  missing ones. `relativePath` is ALWAYS workspace-relative — the
 *  normalizer rejects anything that does not start with
 *  `.trylo/attachments/` or that contains traversal segments. */
export interface PersistedWorkAttachment {
  readonly id: string;
  readonly name: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly size: number;
}

export interface ConversationRecord {
  readonly session: ConversationSession;
  readonly messages: readonly ChatMessage[];
  readonly draft: string;
  /** P2-1 (spec §6.5): mode-scoped result summaries. Optional and
   *  backwards-compatible; has its own `schemaVersion`. Old files without
   *  it simply have no results. */
  readonly results?: StoredConversationResults;
  /** P2-1 Work Package B: Work-surface attachment metadata (staged
   *  files are on disk; records are re-validated on load). Code
   *  attachments are never persisted (memory-only, unchanged). */
  readonly attachments?: readonly PersistedWorkAttachment[];
  /** P3 §7.3: durable ManagedChildBindings for managed-work sessions in this
   *  conversation. Keyed by managedSessionId; `parentToolUseId` replay is
   *  idempotent (returns the original binding). Absent for conversations that
   *  never delegated managed work (backwards compatible). */
  readonly managedChildren?: ManagedChildBindings;
}

export interface WorkspaceConversationHistory {
  /** PR-4: version 2 = ToolMessage carries `outputText` / `outputContent`
   *  (structured tool-result vocabulary; BinaryRef metadata only — never
   *  inline base64). Version 1 files (old `output: string` shape) are
   *  migrated in place by `normalizeWorkspaceHistory`; the FILENAME stays
   *  `.trylo/conversations.v1.json` so no existing conversation is
   *  orphaned by the format move. */
  readonly version: 1 | 2;
  readonly activeByKind: Readonly<Record<ConversationKind, string | null>>;
  readonly conversations: Readonly<Record<string, ConversationRecord>>;
}

export interface PersistedWorkspaceEntry {
  readonly id: string;
  readonly root: FilePath;
  readonly name: string;
}

export interface WorkspaceIndex {
  readonly version: 1;
  readonly workspaces: readonly PersistedWorkspaceEntry[];
  readonly currentWorkspaceId: string;
  readonly topModeByWorkspace: Readonly<Record<string, TopLevelMode>>;
}

const HISTORY_FILE = '.trylo/conversations.v1.json';
const HISTORY_BROWSER_PREFIX = 'trylo:conversation-history:v1:';
const WORKSPACE_INDEX_KEY = 'trylo:workspace-index:v1';
const LEGACY_SESSIONS_KEY = 'trylo:workspace-sessions:v1';
const saveTimers = new Map<string, number>();
const pendingSaves = new Map<
  string,
  {
    root: FilePath;
    history: WorkspaceConversationHistory;
    // A strictly-increasing version per workspace. Every schedule bumps
    // it so the crash-recovery path can assert a stale snapshot never
    // overwrites a fresher one that arrived mid-flight.
    version: number;
  }
>();
const saveVersions = new Map<string, number>();
// M4-C (spec §7.4): single-flight — at most ONE history save may be in
// flight per workspace at any moment. A per-key promise chain serialises
// saves without dropping the freshest pending snapshot: each scheduled
// save runs *after* the previous one settles and drains whatever is
// pending at that moment, so a new snapshot that lands mid-flight is
// written instead of the one that triggered the timer.
const saveChains = new Map<string, Promise<void>>();

export function workspaceKey(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function emptyWorkspaceHistory(): WorkspaceConversationHistory {
  return {
    version: 2,
    activeByKind: { code: null, work: null },
    conversations: {},
  };
}

function modeKind(mode: TryloMode): ConversationKind {
  return mode === 'office' || mode === 'fun' ? 'work' : 'code';
}

function isCodeMode(value: unknown): value is CodeMode {
  return value === 'chat' || value === 'plan' || value === 'agent' || value === 'cognition';
}

function safeMessages(value: unknown): readonly ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ChatMessage => {
    if (!item || typeof item !== 'object') return false;
    const message = item as Partial<ChatMessage>;
    return typeof message.id === 'string'
      && typeof message.kind === 'string'
      && typeof message.role === 'string'
      && typeof message.createdAt === 'number';
  });
}

/**
 * PR-4 (spec §7.2 / §12.2) ToolMessage migration + persisted-shape guard:
 *
 * 1. OLD SHAPE → NEW: a version-1 `output: string` becomes `outputText`
 *    (the tool-result text summary). Old sessions stay fully readable.
 * 2. BINARYREF-ONLY PERSISTENCE: `outputContent` is rebuilt through the
 *    whitelist normalizer — only resolved blocks (text / BinaryRef-carrying
 *    image+audio / resource / resource_link / structured) survive. Any
 *    inline base64 / blob a stale or hand-edited file may carry is
 *    dropped here, before it can re-enter the session state (§15.2
 *    「截图/base64 进入持久会话」 breaker; §7.1 base64 never persists).
 */
function migrateToolMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  let migrated = false;
  const out = messages.map((message) => {
    if (message.kind !== 'tool') return message;
    const raw = message as ToolMessage & { output?: unknown };
    if (raw.output === undefined && raw.outputContent === undefined) return message;
    migrated = true;
    const legacyOutput = typeof raw.output === 'string' ? raw.output : undefined;
    const outputContent = normalizePersistedToolResultContent(raw.outputContent);
    const next: ToolMessage = {
      ...message,
      ...(legacyOutput !== undefined && message.outputText === undefined
        ? { outputText: legacyOutput }
        : {}),
      ...(outputContent !== undefined ? { outputContent } : {}),
    };
    delete (next as { output?: unknown }).output;
    return next;
  });
  return migrated ? out : messages;
}

/** P2-1 Work Package B: strict whitelist normalization of persisted
 *  Work attachment records. Unknown fields are dropped; entries with
 *  missing/invalid fields, absolute paths, or traversal segments are
 *  discarded. Old files without the field normalize to `undefined`
 *  (backwards compatible). */
export function normalizeWorkAttachments(
  value: unknown,
): readonly PersistedWorkAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PersistedWorkAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== 'string' || raw.id.length === 0) continue;
    if (typeof raw.name !== 'string' || raw.name.length === 0) continue;
    if (typeof raw.relativePath !== 'string') continue;
    const relativePath = raw.relativePath;
    // Must stay inside the staging area — never absolute, never
    // traversing up.
    if (!relativePath.startsWith('.trylo/attachments/')) continue;
    if (relativePath.includes('..')) continue;
    if (typeof raw.mediaType !== 'string') continue;
    if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0) continue;
    out.push({
      id: raw.id,
      name: raw.name,
      relativePath,
      mediaType: raw.mediaType,
      size: Math.floor(raw.size),
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeSession(value: unknown, fallbackId: string): ConversationSession | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ConversationSession>;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId;
  if (!id) return null;
  const mode: TryloMode = raw.mode === 'plan' || raw.mode === 'agent' || raw.mode === 'chat'
    || raw.mode === 'cognition' || raw.mode === 'office' || raw.mode === 'fun'
    ? raw.mode
    : 'agent';
  const kind: ConversationKind = raw.kind === 'code' || raw.kind === 'work'
    ? raw.kind
    : modeKind(mode);
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt;
  const codeMode = isCodeMode(raw.codeMode)
    ? raw.codeMode
    : kind === 'code' && isCodeMode(mode) ? mode : undefined;
  return {
    id,
    title: typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim()
      : `New ${kind} chat`,
    mode: kind === 'work' ? 'office' : (codeMode ?? 'agent'),
    kind,
    ...(codeMode ? { codeMode } : {}),
    createdAt,
    updatedAt,
    turnCount: typeof raw.turnCount === 'number' && raw.turnCount >= 0
      ? Math.floor(raw.turnCount)
      : 0,
    // v1.16.5+ (W-RUN-005, Phase B4): persist taskId for
    // refresh recovery. Only meaningful for Work sessions;
    // a Code session that happens to have a taskId field
    // (defensive) is just ignored by the refresh path.
    ...(typeof raw.taskId === 'string' && raw.taskId
      ? { taskId: raw.taskId }
      : {}),
    // v1.16.5+ (M3 closure, spec §5.2): the run binding
    // persists turnId alongside taskId so recovery never
    // guesses the originating user message.
    ...(typeof raw.turnId === 'string' && raw.turnId
      ? { turnId: raw.turnId }
      : {}),
    // v1.16.5+ (Work end-to-end workflow redesign spec §2.3):
    // whitelist the snapshotted turn intent.
    ...(raw.intent === 'conversation' || raw.intent === 'task'
      ? { intent: raw.intent }
      : {}),
    // 2026-09-06: archivedAt is a soft-delete timestamp. Only persisted
    // values that survive Number coercion (Date.now() always does) round-
    // trip; corrupt / non-finite / negative values are dropped so the rail
    // never treats an unarchived session as archived.
    ...(typeof raw.archivedAt === 'number' && Number.isFinite(raw.archivedAt) && raw.archivedAt >= 0
      ? { archivedAt: raw.archivedAt }
      : {}),
  };
}

/**
 * 2026-09-06 (compaction-flood): a persisted conversation can hold hundreds of
 * byte-identical "context compacted" pills — a single compaction amplified into
 * a run by replay/resume with the pre-dedupe reducer (observed: 1689 pills in
 * one real session, all `auto`/no-token-counts). Collapse to the FIRST
 * occurrence of each distinct (tokensBefore, tokensAfter, reason) tuple. This
 * mirrors applyCompact's live identical-redelivery guard so a re-opened session
 * never shows the flood again.
 *
 * Safe for genuine history: a real second compaction always reports grown
 * numbers (its `before` starts where the last `after` left off), so an
 * exact-tuple hit is always a duplicate, never a distinct compaction.
 */
function dedupeCompactions(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.kind === 'compaction') {
      const key = `${m.tokensBefore}|${m.tokensAfter}|${m.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(m);
  }
  return out;
}

export function normalizeWorkspaceHistory(value: unknown): WorkspaceConversationHistory {
  if (!value || typeof value !== 'object') return emptyWorkspaceHistory();
  const raw = value as {
    conversations?: unknown;
    activeByKind?: unknown;
  };
  const conversations: Record<string, ConversationRecord> = {};
  if (raw.conversations && typeof raw.conversations === 'object') {
    for (const [id, item] of Object.entries(raw.conversations)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Partial<ConversationRecord>;
      const session = normalizeSession(record.session, id);
      if (!session) continue;
      const results = normalizeConversationResults(record.results);
      const attachments = normalizeWorkAttachments(record.attachments);
      const managedChildren = deserializeManagedChildBindings(record.managedChildren);
      conversations[session.id] = {
        session,
        messages: dedupeCompactions(migrateToolMessages(safeMessages(record.messages))),
        draft: typeof record.draft === 'string' ? record.draft : '',
        // P2-1: legacy top-level `history.artifacts` is ignored — it has no
        // conversation / run attribution and is not migrated (spec §2.5).
        ...(results ? { results } : {}),
        // P2-1 Work Package B: Work attachment metadata (validated).
        ...(attachments ? { attachments } : {}),
        // P3 §7.3: managed-work child bindings (whitelist-normalized).
        ...(Object.keys(managedChildren).length > 0 ? { managedChildren } : {}),
      };
    }
  }
  const activeRaw = raw.activeByKind && typeof raw.activeByKind === 'object'
    ? raw.activeByKind as Partial<Record<ConversationKind, string | null>>
    : {};
  // 2026-09-06: archived conversations must NEVER be auto-selected as
  // active. `newestFor` filters them out; `validActive` additionally
  // treats an active pointer at an archived conversation as invalid so
  // a stale pointer from before the archive cannot survive a reload.
  // Without this, archiving the current conversation bounced the
  // active pointer straight back to it (it was the newest by
  // updatedAt), leaving the user stuck on an invisible session.
  const newestFor = (kind: ConversationKind): string | null =>
    Object.values(conversations)
      .filter((record) => record.session.kind === kind && !record.session.archivedAt)
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt)[0]?.session.id ?? null;
  const validActive = (kind: ConversationKind): string | null => {
    const id = activeRaw[kind];
    if (typeof id === 'string') {
      const record = conversations[id];
      if (record?.session.kind === kind && !record.session.archivedAt) return id;
    }
    return newestFor(kind);
  };
  // Legacy top-level `history.artifacts` is intentionally ignored (P2-1,
  // spec §2.5): it has no conversation / run attribution and is not
  // migrated to any session. Unknown fields in old JSON are dropped.
  return {
    version: 2,
    activeByKind: { code: validActive('code'), work: validActive('work') },
    conversations,
  };
}

function sessionTitle(kind: ConversationKind, messages: readonly ChatMessage[]): string {
  const firstUser = messages.find(
    (message) => message.kind === 'text' && message.role === 'user' && message.text.trim(),
  );
  if (!firstUser || firstUser.kind !== 'text') return `New ${kind} chat`;
  const title = firstUser.text.replace(/\s+/g, ' ').trim();
  return title.length > 56 ? `${title.slice(0, 55)}…` : title;
}

function turnCount(messages: readonly ChatMessage[]): number {
  return messages.filter((message) => message.kind === 'text' && message.role === 'user').length;
}

export function createConversation(
  history: WorkspaceConversationHistory,
  input: { kind: ConversationKind; codeMode?: CodeMode; now?: number },
): { history: WorkspaceConversationHistory; session: ConversationSession } {
  const now = input.now ?? Date.now();
  const codeMode = input.kind === 'code' ? input.codeMode ?? 'agent' : undefined;
  const id = `${input.kind}-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const session: ConversationSession = {
    id,
    title: `New ${input.kind} chat`,
    mode: input.kind === 'work' ? 'office' : codeMode!,
    kind: input.kind,
    ...(codeMode ? { codeMode } : {}),
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
  };
  return {
    session,
    history: {
      ...history,
      activeByKind: { ...history.activeByKind, [input.kind]: id },
      conversations: {
        ...history.conversations,
        [id]: { session, messages: [], draft: '' },
      },
    },
  };
}

export function ensureConversation(
  history: WorkspaceConversationHistory,
  kind: ConversationKind,
  codeMode: CodeMode = 'agent',
): WorkspaceConversationHistory {
  const activeId = history.activeByKind[kind];
  const activeRecord = activeId ? history.conversations[activeId] : undefined;
  if (activeRecord?.session.kind === kind && !activeRecord.session.archivedAt) return history;
  // 2026-09-06: only LIVE conversations may be re-activated here. Before
  // this filter, archiving the last conversation of a kind bounced the
  // active pointer straight back to the archived row (it was the newest
  // `existing` match) and the user was left on an invisible session.
  const existing = Object.values(history.conversations)
    .filter((record) => record.session.kind === kind && !record.session.archivedAt)
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt)[0];
  if (existing) {
    return {
      ...history,
      activeByKind: { ...history.activeByKind, [kind]: existing.session.id },
    };
  }
  return createConversation(history, { kind, codeMode }).history;
}

export function selectConversation(
  history: WorkspaceConversationHistory,
  id: string,
): WorkspaceConversationHistory {
  const record = history.conversations[id];
  if (!record) return history;
  return {
    ...history,
    activeByKind: { ...history.activeByKind, [record.session.kind]: id },
  };
}

export function deleteConversation(
  history: WorkspaceConversationHistory,
  id: string,
): WorkspaceConversationHistory {
  const removed = history.conversations[id];
  if (!removed) return history;
  const conversations = { ...history.conversations };
  delete conversations[id];
  const next = normalizeWorkspaceHistory({
    ...history,
    conversations,
    activeByKind: {
      ...history.activeByKind,
      [removed.session.kind]: history.activeByKind[removed.session.kind] === id ? null : history.activeByKind[removed.session.kind],
    },
  });
  return ensureConversation(next, removed.session.kind, removed.session.codeMode ?? 'agent');
}

/** 2026-09-06: soft-delete a conversation (kept on disk, hidden from the
 *  active rail list, reachable from the Archived disclosure). The active
 *  pointer is restored to the most-recent non-archived same-kind session;
 *  archivers are still present so the user can un-archive later. No-ops
 *  when the conversation is unknown or already archived. */
export function archiveConversation(
  history: WorkspaceConversationHistory,
  id: string,
  now = Date.now(),
): WorkspaceConversationHistory {
  const record = history.conversations[id];
  if (!record) return history;
  if (record.session.archivedAt) return history;
  const session: ConversationSession = {
    ...record.session,
    archivedAt: now,
    updatedAt: now,
  };
  // Drop the active pointer ONLY if it pointed at the now-archived row;
  // any other active pointer stays. The next read picks a non-archived
  // replacement via `ensureConversation` (called from the rail actions).
  const activeByKind =
    history.activeByKind[record.session.kind] === id
      ? {
        ...history.activeByKind,
        [record.session.kind]: null,
      }
      : history.activeByKind;
  const next = normalizeWorkspaceHistory({
    ...history,
    activeByKind,
    conversations: {
      ...history.conversations,
      [id]: { ...record, session },
    },
  });
  return ensureConversation(next, record.session.kind, record.session.codeMode ?? 'agent');
}

/** 2026-09-06: undo a soft-delete. Stamps the session with an updatedAt
 *  bump so the rail re-sorts it to the top of the active list. No-ops
 *  when the conversation is unknown or never archived. */
export function unarchiveConversation(
  history: WorkspaceConversationHistory,
  id: string,
  now = Date.now(),
): WorkspaceConversationHistory {
  const record = history.conversations[id];
  if (!record || !record.session.archivedAt) return history;
  const next: ConversationSession = { ...record.session };
  delete (next as { archivedAt?: number }).archivedAt;
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [id]: { ...record, session: { ...next, updatedAt: now } },
    },
  };
}

/** 2026-09-06: rename a conversation. Trims the user input and ignores
 *  empty values (the title cannot be cleared — that's `delete`'s job).
 *  No-ops when the conversation is unknown. The history is the only
 *  source of truth; on next save the new title round-trips through
 *  `normalizeSession`'s archivedAt / intent / taskId whitelist. */
export function renameConversation(
  history: WorkspaceConversationHistory,
  id: string,
  title: string,
  now = Date.now(),
): WorkspaceConversationHistory {
  const record = history.conversations[id];
  if (!record) return history;
  const trimmed = title.trim();
  if (!trimmed || trimmed === record.session.title) return history;
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [id]: {
        ...record,
        session: { ...record.session, title: trimmed, updatedAt: now },
      },
    },
  };
}

export function updateConversationMessages(
  history: WorkspaceConversationHistory,
  id: string | null,
  updater: readonly ChatMessage[] | ((previous: readonly ChatMessage[]) => readonly ChatMessage[]),
  now = Date.now(),
): WorkspaceConversationHistory {
  if (!id) return history;
  const record = history.conversations[id];
  if (!record) return history;
  const messages = typeof updater === 'function' ? updater(record.messages) : updater;
  const session: ConversationSession = {
    ...record.session,
    title: sessionTitle(record.session.kind, messages),
    updatedAt: now,
    turnCount: turnCount(messages),
  };
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [id]: { ...record, session, messages },
    },
  };
}

export function updateConversationDraft(
  history: WorkspaceConversationHistory,
  id: string | null,
  draft: string,
): WorkspaceConversationHistory {
  if (!id) return history;
  const record = history.conversations[id];
  if (!record || record.draft === draft) return history;
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [id]: { ...record, draft },
    },
  };
}

/** P2-1 (spec §13.3 / §6.5): fold a normalised conversation result into
 *  history. The value is normalised again before merging so stored JSON
 *  never carries un-whitelisted fields. No-ops when there is nothing new
 *  or the conversation is unknown. */
export function updateConversationResults(
  history: WorkspaceConversationHistory,
  id: string | null,
  results: StoredConversationResults | undefined,
): WorkspaceConversationHistory {
  if (!id) return history;
  const record = history.conversations[id];
  if (!record) return history;
  const normalized = normalizeConversationResults(results);
  if (!normalized) {
    // Clearing results: drop the key when it was present.
    if (!record.results) return history;
    const { results: _drop, ...rest } = record;
    void _drop;
    return {
      ...history,
      conversations: { ...history.conversations, [id]: rest },
    };
  }
  if (record.results === normalized) return history;
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [id]: { ...record, results: normalized },
    },
  };
}

/** P2-1 Work Package B: persist (or clear, with `undefined`) the Work
 *  attachment metadata of a conversation. Records are re-normalized
 *  before storing so saved JSON never carries un-whitelisted fields. */
export function updateConversationAttachments(
  history: WorkspaceConversationHistory,
  id: string | null,
  attachments: readonly PersistedWorkAttachment[] | undefined,
): WorkspaceConversationHistory {
  if (!id) return history;
  const record = history.conversations[id];
  if (!record || record.session.kind !== 'work') return history;
  const normalized = normalizeWorkAttachments(attachments);
  if (!normalized) {
    if (!record.attachments) return history;
    const { attachments: _drop, ...rest } = record;
    void _drop;
    return {
      ...history,
      conversations: { ...history.conversations, [id]: rest },
    };
  }
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [id]: { ...record, attachments: normalized },
    },
  };
}

export function updateConversationCodeMode(
  history: WorkspaceConversationHistory,
  id: string | null,
  codeMode: CodeMode,
): WorkspaceConversationHistory {
  if (!id) return history;
  const record = history.conversations[id];
  if (!record || record.session.kind !== 'code') return history;
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [id]: {
        ...record,
        session: { ...record.session, codeMode, mode: codeMode, updatedAt: Date.now() },
      },
    },
  };
}

/**
 * v1.16.5+ (W-RUN-005 / M4-B): bind the durable `taskId` on a Work
 * conversation. Called after a successful `task.create` (bind) or
 * `task.sendMessage` follow-up (re-binds the same taskId while
 * updating turnId). `taskId === null` CLEARS the binding — used only
 * on the daemon-lost (onStaleBinding) and failed-create paths.
 *
 * NOTE (P2-4): the taskId is a DURABLE thread id and is KEPT after
 * terminal — this function does NOT clear it on a terminal status.
 * The daemon can begin a follow-up run on the same task, and a reload
 * re-binds it via reconcileProject. Persistence happens via the normal
 * `scheduleWorkspaceHistorySave` path; refresh recovery reads the
 * `taskId` back on next launch.
 */
export function bindConversationTask(
  history: WorkspaceConversationHistory,
  id: string,
  taskId: string | null,
  turnId?: string,
  intent?: 'conversation' | 'task',
): WorkspaceConversationHistory {
  const record = history.conversations[id];
  if (!record || record.session.kind !== 'work') return history;
  const session: ConversationSession = taskId
    ? {
        ...record.session,
        taskId,
        // Bind the originating user message with the task
        // (spec §5.2 RunBinding); recovery restores both.
        ...(turnId !== undefined ? { turnId } : {}),
        // Persist the snapshotted intent (spec §2.3) so refresh
        // recovery restores conversation vs task, never guessing.
        ...(intent !== undefined ? { intent } : {}),
        updatedAt: Date.now(),
      }
    : (() => {
        // Strip the optional binding fields rather than
        // leaving them stale; conversations-history
        // normalises to a fresh shape on next read.
        const next: ConversationSession = { ...record.session };
        delete (next as { taskId?: string }).taskId;
        delete (next as { turnId?: string }).turnId;
        delete (next as { intent?: 'conversation' | 'task' }).intent;
        return { ...next, updatedAt: Date.now() };
      })();
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [id]: { ...record, session },
    },
  };
}

/** P3 §7.3: bind a managed-work child to a conversation, persisted through the
 *  normal history save path. Idempotent: replaying the same `parentToolUseId`
 *  returns the existing history unchanged (never a second session). Returns the
 *  same history object when nothing changed so callers can skip the save. */
export function bindManagedChildToConversation(
  history: WorkspaceConversationHistory,
  conversationId: string,
  candidate: ManagedChildBinding,
): WorkspaceConversationHistory {
  const record = history.conversations[conversationId];
  if (!record) return history;
  const existing = record.managedChildren ?? {};
  const { next, binding } = bindManagedChild(existing, candidate);
  if (next === existing) return history;
  return {
    ...history,
    conversations: {
      ...history.conversations,
      [conversationId]: {
        ...record,
        managedChildren: next,
        session: { ...record.session, updatedAt: binding.updatedAt },
      },
    },
  };
}

/** P3 §7.3: read the managed-work bindings for a conversation. */
export function managedChildrenForConversation(
  history: WorkspaceConversationHistory,
  conversationId: string,
): ManagedChildBindings {
  return history.conversations[conversationId]?.managedChildren ?? {};
}

export function listConversationSessions(
  history: WorkspaceConversationHistory,
): readonly ConversationSession[] {
  // Sort by the last USER message's created time (stable during a live run).
  // `session.updatedAt` is bumped on EVERY stream event, so with two concurrent
  // tasks in one folder the list kept re-sorting on each flush and the entries
  // flickered/shuffled. A user turn's created time only moves when the user
  // actually sends a new message — recent-first is preserved without churn.
  const lastUserTurn = (record: ConversationRecord): number => {
    for (let i = record.messages.length - 1; i >= 0; i -= 1) {
      const m = record.messages[i];
      if (m && m.kind === 'text' && m.role === 'user') return m.createdAt;
    }
    return record.session.createdAt;
  };
  return Object.values(history.conversations)
    .map((record) => record.session)
    .sort((a, b) => {
      const ra = history.conversations[a.id]!;
      const rb = history.conversations[b.id]!;
      const diff = lastUserTurn(rb) - lastUserTurn(ra);
      return diff !== 0 ? diff : b.updatedAt - a.updatedAt;
    });
}

function browserHistoryKey(root: string): string {
  return `${HISTORY_BROWSER_PREFIX}${workspaceKey(root)}`;
}

function readBrowserBackup(root: string): WorkspaceConversationHistory | null {
  try {
    const raw = window.localStorage.getItem(browserHistoryKey(root));
    return raw ? normalizeWorkspaceHistory(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function migrateLegacySessions(root: string): WorkspaceConversationHistory | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_SESSIONS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { workspaces?: Record<string, readonly TryloSession[]>; active?: Record<string, string> };
    const sessions = parsed.workspaces?.[root] ?? parsed.workspaces?.[workspaceKey(root)] ?? [];
    if (sessions.length === 0) return null;
    let history = emptyWorkspaceHistory();
    for (const legacy of sessions) {
      const session = normalizeSession(legacy, legacy.id);
      if (!session) continue;
      history = {
        ...history,
        conversations: {
          ...history.conversations,
          [session.id]: { session, messages: [], draft: '' },
        },
      };
    }
    const active = parsed.active?.[root] ?? parsed.active?.[workspaceKey(root)];
    history = normalizeWorkspaceHistory(history);
    return active && history.conversations[active]
      ? selectConversation(history, active)
      : history;
  } catch {
    return null;
  }
}

export async function loadWorkspaceHistory(root: FilePath): Promise<WorkspaceConversationHistory> {
  if (typeof window !== 'undefined' && isTauri()) {
    try {
      const raw = await invoke<string | null>('conversation_history_load', { workspaceRoot: root });
      if (raw) return normalizeWorkspaceHistory(JSON.parse(raw));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[trylo] project history load failed; using browser backup', error);
    }
  }
  return readBrowserBackup(root) ?? migrateLegacySessions(root) ?? emptyWorkspaceHistory();
}

export async function saveWorkspaceHistory(
  root: FilePath,
  history: WorkspaceConversationHistory,
): Promise<void> {
  const json = JSON.stringify(history);
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(browserHistoryKey(root), json); } catch { /* backup is best effort */ }
  }
  if (typeof window !== 'undefined' && isTauri()) {
    await invoke('conversation_history_save', { workspaceRoot: root, json });
  }
}

/**
 * M4-C (§7.4): drain the *latest* pending snapshot of a workspace. It
 * always reads the current `pendingSaves` entry, so a fresher snapshot
 * that arrived while the previous save was settling is written instead
 * of the one that triggered the timer — stale data never overwrites new.
 */
async function drainWorkspaceSave(key: string): Promise<void> {
  const pending = pendingSaves.get(key);
  if (!pending) return;
  pendingSaves.delete(key);
  await saveWorkspaceHistory(pending.root, pending.history);
}

/** Serialise this workspace's saves onto one promise chain (single-flight). */
function enqueueWorkspaceSave(key: string): void {
  const prior = saveChains.get(key) ?? Promise.resolve();
  const chain = prior
    .catch(() => undefined) // a failed save never blocks the next one
    .then(() => drainWorkspaceSave(key).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[trylo] project history save failed', error);
    }));
  saveChains.set(key, chain);
  void chain.then(() => {
    if (saveChains.get(key) === chain) saveChains.delete(key);
  });
}

export function scheduleWorkspaceHistorySave(
  root: FilePath,
  history: WorkspaceConversationHistory,
  // P2-1: 300ms → 1s. Write-behind batches stream deltas; combined
  // with pending-merge + single-flight, a 1s window still collapses
  // every burst onto the newest snapshot (spec §7.4). Terminal / mode
  // switch / blur force-flush, so the longer window loses nothing.
  delayMs = 1000,
): void {
  const key = workspaceKey(root);
  const version = (saveVersions.get(key) ?? 0) + 1;
  saveVersions.set(key, version);
  // Merge into pending rather than scheduling an independent write; a burst
  // of stream deltas collapses onto the newest snapshot (no concurrent
  // clobbering, spec §7.4).
  pendingSaves.set(key, { root, history, version });
  if (saveTimers.has(key)) return; // debounce already scheduled
  saveTimers.set(key, window.setTimeout(() => {
    saveTimers.delete(key);
    enqueueWorkspaceSave(key);
  }, delayMs));
}

/**
 * M4-C (§7.4): force a synchronous flush for a workspace, used at
 * terminal / mode switch / app blur / exit. Any in-flight save is awaited
 * first; a `history` argument (if supplied) is treated as the newest
 * pending snapshot so nothing confirmed is dropped.
 */
export async function forceFlushHistory(
  root: FilePath,
  history?: WorkspaceConversationHistory,
): Promise<void> {
  const key = workspaceKey(root);
  if (history) {
    const version = (saveVersions.get(key) ?? 0) + 1;
    saveVersions.set(key, version);
    pendingSaves.set(key, { root, history, version });
  }
  const timer = saveTimers.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    saveTimers.delete(key);
  }
  enqueueWorkspaceSave(key);
  const chain = saveChains.get(key);
  if (chain) await chain;
}

/** Flush every workspace that has pending or in-flight work (app exit). */
export async function flushAllPendingSaves(): Promise<void> {
  const keys = new Set([
    ...pendingSaves.keys(),
    ...saveTimers.keys(),
    ...saveChains.keys(),
  ]);
  for (const key of keys) {
    const timer = saveTimers.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      saveTimers.delete(key);
    }
    if (pendingSaves.has(key)) enqueueWorkspaceSave(key);
  }
  await Promise.all([...saveChains.values()]);
}

/**
 * M4-C (§7.4/§11.4): best-effort flush of every pending snapshot on app
 * close / crash. `beforeunload` cannot await the async Tauri save, so this
 * synchronously persists to the localStorage backup — never dropping the
 * latest confirmed state. A graceful Tauri exit still runs
 * `flushAllPendingSaves`; this covers the browser fallback and abrupt
 * teardown. Idempotent; safe to call from module setup.
 */
let unloadFlushRegistered = false;
export function registerUnloadHistoryFlush(): void {
  if (unloadFlushRegistered || typeof window === 'undefined') return;
  unloadFlushRegistered = true;
  window.addEventListener('beforeunload', () => {
    for (const pending of pendingSaves.values()) {
      try {
        window.localStorage.setItem(
          browserHistoryKey(pending.root),
          JSON.stringify(pending.history),
        );
      } catch { /* best effort */ }
    }
  });
}

export function loadWorkspaceIndex(defaultWorkspace: PersistedWorkspaceEntry): WorkspaceIndex {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_INDEX_KEY);
    if (!raw) throw new Error('missing');
    const parsed = JSON.parse(raw) as Partial<WorkspaceIndex>;
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces.filter((workspace): workspace is PersistedWorkspaceEntry =>
        !!workspace && typeof workspace.id === 'string' && typeof workspace.root === 'string' && typeof workspace.name === 'string')
      : [];
    const withDefault = workspaces.length > 0 ? workspaces : [defaultWorkspace];
    const currentWorkspaceId = withDefault.some((workspace) => workspace.id === parsed.currentWorkspaceId)
      ? parsed.currentWorkspaceId!
      : withDefault[0]!.id;
    return {
      version: 1,
      workspaces: withDefault,
      currentWorkspaceId,
      topModeByWorkspace: parsed.topModeByWorkspace ?? {},
    };
  } catch {
    return {
      version: 1,
      workspaces: [defaultWorkspace],
      currentWorkspaceId: defaultWorkspace.id,
      topModeByWorkspace: {},
    };
  }
}

export function saveWorkspaceIndex(index: WorkspaceIndex): void {
  try { window.localStorage.setItem(WORKSPACE_INDEX_KEY, JSON.stringify(index)); } catch { /* best effort */ }
}

export { HISTORY_FILE };
