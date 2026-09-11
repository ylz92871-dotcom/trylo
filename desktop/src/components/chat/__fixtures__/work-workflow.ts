// Trylo Desktop — fixture: Work ConversationItem sequences for
// workflow projection (WP-0 of the Work workflow UI refactor,
// see docs/TRYLO-WORKFLOW-APPROVAL-DIFF-UI-IMPROVEMENT-SPEC-2026-08-29.md).
//
// Hand-crafted, NOT a captured run. Four scenarios, each a
// function returning a `readonly ConversationItem[]` ready to
// feed through `applyWorkflowItem` / `applyWorkItem`:
//
//   - normalFourPhases:  plan(started/finished g1..g4) + thinking
//                        + tools + final. The "happy path".
//   - failedWorkflow:    plan(finished g1 completed) + plan(finished
//                        g2 failed) + error. The phase g2 stays failed.
//   - duplicateReplay:   normalFourPhases replayed twice. After both
//                        passes the workflow has the same phases /
//                        activities (replay-idempotency).
//   - outOfOrder:        plan(finished g1 completed) arrives BEFORE
//                        plan(started g1). The reducer merges into a
//                        single phase with no crash.

import type { ConversationItem } from '@trylo/work';

const CONVERSATION_ID = 'conv-workflow-fixture';
const IDENTITY = {
  taskId: 'task-fixture',
  runId: 'run:task-fixture',
  turnId: 'turn-1',
} as const;

let _at = 1000;
function nextAt(deltaMs = 50): number {
  _at += deltaMs;
  return _at;
}

// Reset the timestamp cursor before each scenario so exports
// can be replayed in any order without collisions.
function resetAt(start = 1000): void {
  _at = start;
}

function thinking(text: string, phaseId?: string): ConversationItem {
  return {
    ...IDENTITY,
    kind: 'thinking',
    id: `th-${nextAt()}`,
    at: nextAt(),
    conversationId: CONVERSATION_ID,
    text,
    phaseId,
  };
}

function plan(
  name: string,
  stage: 'started' | 'finished',
  phaseId: string,
  text?: string,
): ConversationItem {
  return {
    ...IDENTITY,
    kind: 'plan',
    id: `pl-${nextAt()}`,
    at: nextAt(),
    conversationId: CONVERSATION_ID,
    stage,
    name,
    text: text ?? name,
    phaseId,
  };
}

function tool(
  stepId: string,
  status: 'running' | 'done' | 'error',
  summary: string,
  phaseId?: string,
): ConversationItem {
  return {
    ...IDENTITY,
    kind: 'tool',
    id: `tool-${stepId}`,
    at: nextAt(),
    conversationId: CONVERSATION_ID,
    tool: 'read_file',
    summary,
    status,
    phaseId,
    toolCallId: stepId,
  };
}

function progress(text: string, toolCallId?: string): ConversationItem {
  return {
    ...IDENTITY,
    kind: 'progress',
    id: `pr-${nextAt()}`,
    at: nextAt(),
    conversationId: CONVERSATION_ID,
    text,
    toolCallId,
  };
}

function final(text: string): ConversationItem {
  return {
    ...IDENTITY,
    kind: 'final',
    id: `fin-${nextAt()}`,
    at: nextAt(),
    conversationId: CONVERSATION_ID,
    text,
  };
}

function error(userMessage: string, diagnosticId: string): ConversationItem {
  return {
    ...IDENTITY,
    kind: 'error',
    id: `err-${nextAt()}`,
    at: nextAt(),
    conversationId: CONVERSATION_ID,
    userMessage,
    diagnosticId,
  };
}

// --------------------------------------------------------------------------
// Scenario 1: normal four-phase happy path.
// --------------------------------------------------------------------------
export function normalFourPhases(): readonly ConversationItem[] {
  resetAt();
  return [
    // Phase 1: DISCOVER
    plan('DISCOVER', 'started', 'g1'),
    thinking('Reading project structure', 'g1'),
    tool('step-1', 'done', 'read_file repo root', 'g1'),
    plan('DISCOVER', 'finished', 'g1', 'Completed DISCOVER'),
    // Phase 2: PLAN
    plan('PLAN', 'started', 'g2'),
    thinking('Drafting plan', 'g2'),
    plan('PLAN', 'finished', 'g2', 'Completed PLAN'),
    // Phase 3: BUILD
    plan('BUILD', 'started', 'g3'),
    thinking('Writing code', 'g3'),
    tool('step-2', 'running', 'edit_file src/foo.ts', 'g3'),
    tool('step-2', 'done', 'edit_file src/foo.ts', 'g3'),
    plan('BUILD', 'finished', 'g3', 'Completed BUILD'),
    // Phase 4: VERIFY
    plan('VERIFY', 'started', 'g4'),
    thinking('Running tests', 'g4'),
    plan('VERIFY', 'finished', 'g4', 'Completed VERIFY'),
    final('All four phases done'),
  ];
}

// --------------------------------------------------------------------------
// Scenario 2: failed workflow (phase 2 fails, run errors out).
// --------------------------------------------------------------------------
export function failedWorkflow(): readonly ConversationItem[] {
  resetAt();
  return [
    plan('DISCOVER', 'started', 'g1'),
    plan('DISCOVER', 'finished', 'g1', 'Completed DISCOVER'),
    plan('BUILD', 'started', 'g2'),
    tool('step-1', 'error', 'edit_file src/x.ts: failed', 'g2'),
    plan('BUILD', 'finished', 'g2', 'BUILD failed'),
    error('Build step failed: see diagnostics', 'diag-1'),
  ];
}

// --------------------------------------------------------------------------
// Scenario 3: duplicate / replay — apply normalFourPhases TWICE
// through the reducer. The final workflow must have the same
// phases / activities as a single pass (replay idempotency).
// --------------------------------------------------------------------------
export function duplicateReplay(): readonly ConversationItem[] {
  return [...normalFourPhases(), ...normalFourPhases()];
}

// --------------------------------------------------------------------------
// Scenario 4: out-of-order — finished arrives before started.
// The reducer must not crash and must still merge into a
// single completed phase (no double-card, no orphan).
// --------------------------------------------------------------------------
export function outOfOrder(): readonly ConversationItem[] {
  resetAt();
  return [
    // finished first
    plan('DISCOVER', 'finished', 'g1', 'Completed DISCOVER'),
    // started later
    plan('DISCOVER', 'started', 'g1'),
    // then a real finished to close it
    plan('DISCOVER', 'finished', 'g1', 'Completed DISCOVER'),
  ];
}

// Helpers used by tests outside this fixture file.
export const fixtureHelpers = {
  CONVERSATION_ID,
  IDENTITY,
  resetAt,
  thinking,
  plan,
  tool,
  progress,
  final,
  error,
} as const;
