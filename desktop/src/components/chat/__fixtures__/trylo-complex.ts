// Trylo Desktop — fixture: 6-turn agent run with 28 events.
// Hand-crafted based on trylo cli docs/EVENT_VOCABULARY.md.
// Used by events.test.ts as the ground-truth input for the
// reducer. NOT a real CLI run; the real run requires
// ANTHROPIC_API_KEY which we don't have in dev.

import type { LoopEvent } from '../../../host-adapter/loop-events';

function ev(seq: number, ts: number, e: Omit<LoopEvent, 'seq' | 'ts'>): LoopEvent {
  return { seq, ts, ...e } as LoopEvent;
}

let seq = 0;
let ts = 0;
function next(deltaMs = 100): number { ts += deltaMs; return ts; }

// 6 turns × ~6 events/turn = 36 events + session/loop frames.
export const fixture: readonly LoopEvent[] = [
  ev(++seq, next(), { type: 'session_start', sessionId: 'fix-1', model: 'claude-sonnet-4-6', cwd: 'C:/work/demo-ws', permissionMode: 'default' } as never),
  ev(++seq, next(), { type: 'loop_start', sessionId: 'fix-1', model: 'claude-sonnet-4-6', promptSummary: 'Find the brand color in the project docs', tools: ['Read', 'Bash', 'Grep', 'Edit'] } as never),

  // Turn 1
  ev(++seq, next(), { type: 'turn_start', turn: 1, depth: 0, agentId: null } as never),
  ev(++seq, next(), { type: 'thinking', turn: 1, preview: 'long preview', summary: 'Find brand color.', fullLength: 84 } as never),
  ev(++seq, next(), { type: 'tool_use', turn: 1, id: 'tu-1', tool: 'Grep', input: { pattern: 'brand.*color', path: 'C:/work/demo-ws/docs' }, parentId: undefined } as never),
  ev(++seq, next(), { type: 'tool_result', turn: 1, id: 'tu-1', tool: 'Grep', ok: true, output: 'docs/ARCHITECTURE.md:42: Trylo Gold #DBC97F', durationMs: 220 } as never),
  ev(++seq, next(), { type: 'text', turn: 1, preview: 'Found it.', text: 'Found it.' } as never),
  ev(++seq, next(), { type: 'turn_end', turn: 1, stopReason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 80 } } as never),

  // Turn 2
  ev(++seq, next(), { type: 'turn_start', turn: 2, depth: 0, agentId: null } as never),
  ev(++seq, next(), { type: 'thinking', turn: 2, preview: 'long preview', summary: 'Check tokens file.', fullLength: 79 } as never),
  ev(++seq, next(), { type: 'tool_use', turn: 2, id: 'tu-2', tool: 'Read', input: { file_path: 'C:/work/demo-ws/desktop/src/styles/tokens.css' }, parentId: undefined } as never),
  ev(++seq, next(), { type: 'tool_result', turn: 2, id: 'tu-2', tool: 'Read', ok: true, output: ':root { --brand: #DBC97F; ... }', durationMs: 30 } as never),
  ev(++seq, next(), { type: 'text', turn: 2, preview: 'Tokens have brand + 5 shades.', text: 'Tokens have brand + 5 shades.' } as never),
  ev(++seq, next(), { type: 'turn_end', turn: 2, stopReason: 'end_turn', usage: { input_tokens: 1300, output_tokens: 110 } } as never),

  // Turn 3
  ev(++seq, next(), { type: 'turn_start', turn: 3, depth: 0, agentId: null } as never),
  ev(++seq, next(), { type: 'thinking', turn: 3, preview: 'long preview', summary: 'Find Trylo Gold usage.', fullLength: 74 } as never),
  ev(++seq, next(), { type: 'tool_use', turn: 3, id: 'tu-3', tool: 'Grep', input: { pattern: 'Trylo Gold|#DBC97F', path: 'C:/work/demo-ws/desktop/src' }, parentId: undefined } as never),
  ev(++seq, next(), { type: 'tool_result', turn: 3, id: 'tu-3', tool: 'Grep', ok: true, output: 'tokens.css: brand\nLogo.tsx: brand gradient', durationMs: 110 } as never),
  ev(++seq, next(), { type: 'text', turn: 3, preview: 'Two sites.', text: 'Two sites.' } as never),
  ev(++seq, next(), { type: 'turn_end', turn: 3, stopReason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 130 } } as never),

  // Compaction
  ev(++seq, next(), { type: 'compaction_trigger', trigger: 'auto', preTokens: 184000, postTokens: 42000 } as never),
  ev(++seq, next(), { type: 'compact', kind: 'boundary', tokensBefore: 184000, tokensAfter: 42000, reason: 'auto' } as never),

  // Turn 4 (post-compaction)
  ev(++seq, next(), { type: 'turn_start', turn: 4, depth: 0, agentId: null } as never),
  ev(++seq, next(), { type: 'thinking', turn: 4, preview: 'After compaction, verify Logo still uses brand token.', summary: 'Verify Logo post-compaction.', fullLength: 75 } as never),
  ev(++seq, next(), { type: 'tool_use', turn: 4, id: 'tu-4', tool: 'Read', input: { file_path: 'C:/work/demo-ws/desktop/src/brand/Logo.tsx' }, parentId: undefined } as never),
  ev(++seq, next(), { type: 'tool_result', turn: 4, id: 'tu-4', tool: 'Read', ok: true, output: 'var(--brand-200, #E3D493)', durationMs: 28 } as never),
  ev(++seq, next(), { type: 'text', turn: 4, preview: 'Logo uses brand shades.', text: 'Logo uses brand shades.' } as never),
  ev(++seq, next(), { type: 'turn_end', turn: 4, stopReason: 'end_turn', usage: { input_tokens: 1800, output_tokens: 95 } } as never),

  // Turn 5 (sub-agent)
  ev(++seq, next(), { type: 'turn_start', turn: 5, depth: 0, agentId: null } as never),
  ev(++seq, next(), { type: 'thinking', turn: 5, preview: 'I should delegate the hardcoded-color scan to a sub-agent to keep the context light.', summary: 'Delegate hardcoded scan.', fullLength: 92 } as never),
  ev(++seq, next(), { type: 'subagent', kind: 'spawn', parentId: 'turn-5', id: 'sub-1', agentType: 'Explore', prompt: 'Find hardcoded colors' } as never),
  ev(++seq, next(), { type: 'tool_use', turn: 5, id: 'tu-5', tool: 'Grep', input: { pattern: '#[0-9A-F]{6}', path: 'C:/work/demo-ws/desktop/src' }, parentId: 'sub-1' } as never),
  ev(++seq, next(), { type: 'tool_result', turn: 5, id: 'tu-5', tool: 'Grep', ok: true, output: '12 files with hardcoded hex', durationMs: 180 } as never),
  ev(++seq, next(), { type: 'subagent', kind: 'end', id: 'sub-1', result: '12 hardcoded colors', durationMs: 2400 } as never),
  ev(++seq, next(), { type: 'text', turn: 5, preview: '12 hardcoded colors.', text: '12 hardcoded colors.' } as never),
  ev(++seq, next(), { type: 'turn_end', turn: 5, stopReason: 'end_turn', usage: { input_tokens: 2200, output_tokens: 180 } } as never),

  // Turn 6 (final)
  ev(++seq, next(), { type: 'turn_start', turn: 6, depth: 0, agentId: null } as never),
  ev(++seq, next(), { type: 'thinking', turn: 6, preview: 'Compose the final answer summarizing all the findings.', summary: 'Compose final answer.', fullLength: 65 } as never),
  ev(++seq, next(), { type: 'text', turn: 6, preview: 'Trylo Gold is #DBC97F.', text: 'Trylo Gold is #DBC97F.' } as never),
  ev(++seq, next(), { type: 'turn_end', turn: 6, stopReason: 'end_turn', usage: { input_tokens: 2400, output_tokens: 250 } } as never),

  // End
  ev(++seq, next(), { type: 'loop_end', durationMs: 18200, totalCost: 0.0241, numTurns: 6, reason: 'success', finalResult: 'Trylo Gold is #DBC97F.' } as never),
  ev(++seq, next(), { type: 'session_end', sessionId: 'fix-1', durationMs: 18800, reason: 'success' } as never),
];

export const fixtureSummary = {
  totalEvents: fixture.length,
  turnCount: 6,
  toolUseCount: fixture.filter((e) => e.type === 'tool_use').length,
  toolResultCount: fixture.filter((e) => e.type === 'tool_result').length,
  thinkingCount: fixture.filter((e) => e.type === 'thinking').length,
  subagentCount: fixture.filter((e) => e.type === 'subagent').length,
  compactionCount: fixture.filter((e) => e.type === 'compact').length,
};
