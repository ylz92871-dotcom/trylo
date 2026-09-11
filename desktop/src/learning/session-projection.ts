// Trylo Desktop — conversation → Hermes session projection.
//
// Pure function: `ConversationRecord` (Desktop's authoritative state) → the
// projection the Hermes session mirror indexes (spec §1 / §7.4). No I/O, no
// clock, no randomness — the same record always yields the same projection,
// which is exactly what the mirror's "content hash skip" relies on: without
// determinism every read would look changed and re-upload the whole history.
//
// Ownership: Desktop owns the conversation; this only re-shapes it. The
// projection is a rebuildable cache — Hermes may drop it at any time and
// `rebuildSessions` regenerates it (arch §6.4).
//
// Failure policy: never throws. Unusable input yields an empty turn list —
// a conversation with no complete turn is simply nothing to recall.

import type { ChatMessage } from '../components/chat/types';
import type { ConversationRecord } from '../host-adapter/conversation-history';
import type { FilePath } from '../host-adapter/types';
import type { LearningSessionProjection } from './learning-port';
import type { LearningRunEventSummary } from '../services-host/methods';

export interface SessionProjectionInput {
  readonly record: ConversationRecord;
  /** Workspace root for the conversation (the run `cwd`). */
  readonly workspacePath: FilePath;
  /** Model id, when the run knows it. */
  readonly model?: string;
}

function isText(m: ChatMessage): m is ChatMessage & { kind: 'text'; text: string } {
  return m.kind === 'text' && typeof (m as { text?: unknown }).text === 'string';
}

function isUser(m: ChatMessage): boolean {
  return m.role === 'user';
}

function isAssistant(m: ChatMessage): boolean {
  return m.role === 'assistant';
}

function isTool(m: ChatMessage): m is ChatMessage & {
  kind: 'tool';
  tool: string;
  summary: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'interrupted';
  toolCallId?: string;
} {
  return m.kind === 'tool';
}

// toolCategory — the projected evidence category for a tool card. Code rules
// only understand `read|edit|write|...`; Work surfaces need their OWN category
// so the evidence capsule can reason about Office / browser / desktop tools
// (TRYLO-DUAL-SURFACE-SPEC §2.5). Work matchers run FIRST (a `browser_*` tool
// contains `browser`, and `mcp__trylo-office` must win before the generic
// `tool` bucket). The production tool names are FROZEN contracts — never
// invent synthetic ids like `mcp__trylo-office__create_pptx`.
export function toolCategory(tool: string): string {
  const name = tool.toLowerCase();
  // Work surface FIRST.
  if (/mcp__trylo-office|officecli|(^|_)office(_|$)/i.test(name)) return 'office';
  if (/mcp__chrome-devtools|playwright|^browser_|mcp__playwright/i.test(name)) return 'browser';
  if (/mcp__windows|windows-mcp|windows_mcp/i.test(name)) return 'desktop';
  // Then Code generic.
  if (/read|view|open/.test(name)) return 'read';
  if (/grep|glob|search|find/.test(name)) return 'search';
  if (/edit|patch|replace/.test(name)) return 'edit';
  if (/write|create/.test(name)) return 'write';
  if (/test|verify|check/.test(name)) return 'verify';
  if (/bash|shell|command|terminal|exec/.test(name)) return 'command';
  return 'tool';
}

function safeEventTitle(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9._-]{8,})/gi, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s,;]{3,})/gi, '$1[REDACTED]')
    .slice(0, 200);
}

function isoTimestamp(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Project one conversation into the Hermes session shape.
 *
 * Turns are grouped by `turnId` (falling back to the user message id), so
 * edit-and-resend and out-of-order events cannot shift the pairing. Only
 * non-streaming text is projected: a `partial` assistant fragment is a
 * transient render artefact, not a recalled answer.
 */
export function projectSession(input: SessionProjectionInput): LearningSessionProjection {
  const record = input.record;
  const session = record?.session;
  const messages = record?.messages ?? [];

  const turns: { prompt: string; resultText: string; startedAt?: string; events: LearningRunEventSummary[] }[] = [];
  const indexByTurn = new Map<string, number>();

  for (const message of messages) {
    if (isTool(message)) {
      const key = message.turnId;
      const index = key ? indexByTurn.get(key) : undefined;
      const turn = index === undefined ? undefined : turns[index];
      if (!turn) continue;
      turn.events.push({
        id: message.toolCallId || message.id,
        category: toolCategory(message.tool),
        title: safeEventTitle(message.summary || message.tool),
        status: message.status === 'done' ? 'done' : message.status === 'interrupted' ? 'error' : message.status,
      });
      continue;
    }
    if (!isText(message)) continue;
    const text = message.text ?? '';

    if (isUser(message)) {
      const key = message.turnId || message.id;
      if (indexByTurn.has(key)) continue;
      indexByTurn.set(key, turns.length);
      turns.push({
        prompt: text,
        resultText: '',
        startedAt: isoTimestamp(
          (message as { turnStartedAt?: number }).turnStartedAt ?? message.createdAt,
        ),
        events: [],
      });
      continue;
    }

    if (isAssistant(message)) {
      if (message.partial) continue;
      const key = message.turnId || message.id;
      const index = indexByTurn.get(key);
      // An assistant fragment with no user turn (truncated history) is not a
      // recallable exchange — drop it rather than inventing a prompt.
      if (index === undefined) continue;
      const turn = turns[index];
      if (!turn) continue;
      turns[index] = {
        prompt: turn.prompt,
        resultText: turn.resultText ? `${turn.resultText}\n${text}` : text,
        startedAt: turn.startedAt,
        events: turn.events,
      };
    }
  }

  return {
    id: session?.id ?? '',
    title: session?.title ?? '',
    workspace: { path: input.workspacePath ?? '' },
    model: input.model,
    // Only complete exchanges enter recall. Failed/cancelled runs must not
    // leave a user-only prompt in Hermes as if it were a settled result.
    turns: turns.filter((turn) => turn.prompt.trim().length > 0 && turn.resultText.trim().length > 0),
  };
}

/** True when a projection is worth mirroring (an id plus at least one
 *  complete exchange). Guards the mirror against empty drafts. */
export function isProjectableSession(projection: LearningSessionProjection): boolean {
  return Boolean(projection.id) && projection.turns.some(
    (turn) => turn.prompt.trim().length > 0 && turn.resultText.trim().length > 0,
  );
}
