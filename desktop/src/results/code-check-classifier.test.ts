// Trylo Desktop — code-check-classifier tests (P2-1, §7.6).

import { describe, expect, it } from 'vitest';
import type { LoopEvent, ToolResultEvent, ToolUseEvent, AbortedEvent } from '../host-adapter/loop-events';
import {
  classifyCheckCommand,
  classifyCodeChecks,
  checkLabel,
} from './code-check-classifier';

function toolUse(id: string, tool: string, command: string): ToolUseEvent {
  return {
    type: 'tool_use',
    seq: 1,
    ts: 1,
    turn: 1,
    id,
    tool,
    input: { command },
  };
}

function toolResult(id: string, ok: boolean, durationMs = 100): ToolResultEvent {
  return {
    type: 'tool_result',
    seq: 2,
    ts: 2,
    turn: 1,
    id,
    tool: 'Bash',
    ok,
    output: 'x',
    durationMs,
  };
}

describe('classifyCheckCommand allowlist', () => {
  const cases: Array<[string, string]> = [
    ['pnpm test', 'test'],
    ['npm run test -- --run', 'test'],
    ['yarn test', 'test'],
    ['bun test', 'test'],
    ['vitest run', 'test'],
    ['jest', 'test'],
    ['pytest -q', 'test'],
    ['cargo test --lib', 'test'],
    ['go test ./...', 'test'],
    ['dotnet test', 'test'],
    ['npx tsc --noEmit', 'typecheck'],
    ['pnpm run typecheck', 'typecheck'],
    ['eslint src', 'lint'],
    ['pnpm run lint', 'lint'],
    ['cargo clippy -- -D warnings', 'lint'],
    ['pnpm build', 'build'],
    ['npm run build', 'build'],
    ['yarn build', 'build'],
    ['cargo build', 'build'],
    ['prettier --check .', 'format'],
    ['cargo fmt --check', 'format'],
    ['cd /repo && npm test', 'test'],
  ];
  for (const [cmd, kind] of cases) {
    it(`classifies "${cmd}" as ${kind}`, () => {
      expect(classifyCheckCommand(cmd)?.kind).toBe(kind);
    });
  }

  it('does not classify plain / unsafe shell commands', () => {
    expect(classifyCheckCommand('cat file.txt')).toBeNull();
    expect(classifyCheckCommand('ls')).toBeNull();
    expect(classifyCheckCommand('git status')).toBeNull();
    expect(classifyCheckCommand('node script.js')).toBeNull();
  });

  it('does NOT classify `echo test` or reading a test-utils file (M2)', () => {
    expect(classifyCheckCommand('echo test')).toBeNull();
    expect(classifyCheckCommand('cat test-utils.js')).toBeNull();
    expect(classifyCheckCommand('ls test')).toBeNull();
  });

  it('does NOT split checks on `;` (M2)', () => {
    // `;` chains are not a promised check separator; a `;`-joined command is
    // never treated as one check.
    expect(classifyCheckCommand('git add .; pnpm test')).toBeNull();
    expect(classifyCheckCommand('cd x && pnpm test; true')).toBeNull();
  });
});

describe('checkLabel', () => {
  it('keeps pnpm test short', () => {
    expect(checkLabel('pnpm test -- --run')).toBe('pnpm test');
  });
  it('elides `run` for pnpm run typecheck', () => {
    expect(checkLabel('pnpm run typecheck')).toBe('pnpm typecheck');
  });
  it('keeps cargo clippy short', () => {
    expect(checkLabel('cargo clippy --all')).toBe('cargo clippy');
  });
  it('labels `cd desktop && pnpm test` as `pnpm test` (M2)', () => {
    expect(checkLabel('cd desktop && pnpm test')).toBe('pnpm test');
  });
});

describe('classifyCodeChecks', () => {
  it('pairs tool_use + tool_result into a passed check', () => {
    const events: LoopEvent[] = [toolUse('t1', 'Bash', 'pnpm test'), toolResult('t1', true)];
    const checks = classifyCodeChecks(events, { runId: 'r1' });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'r1:t1',
      label: 'pnpm test',
      kind: 'test',
      status: 'passed',
      durationMs: 100,
    });
  });

  it('tags a failed tool result as failed', () => {
    const events: LoopEvent[] = [toolUse('x', 'Bash', 'cargo clippy'), toolResult('x', false)];
    expect(classifyCodeChecks(events, { runId: 'r' })[0]?.status).toBe('failed');
  });

  it('ignores non-shell tools entirely', () => {
    const nonShell = { ...toolUse('n', 'Write', 'npm test'), tool: 'Write' };
    const events: LoopEvent[] = [nonShell, toolResult('n', true)];
    expect(classifyCodeChecks(events, { runId: 'r' })).toHaveLength(0);
  });

  it('drops a classified tool_use that never got a result', () => {
    const events: LoopEvent[] = [toolUse('orphan', 'Bash', 'npm test')];
    expect(classifyCodeChecks(events, { runId: 'r' })).toHaveLength(0);
  });

  it('upserts on a duplicate toolCallId instead of appending', () => {
    const events: LoopEvent[] = [
      toolUse('d', 'Bash', 'npm test'),
      toolUse('d', 'Bash', 'npm test'),
      toolResult('d', true),
    ];
    expect(classifyCodeChecks(events, { runId: 'r' })).toHaveLength(1);
  });

  it('ignores assistant text — only tool events matter', () => {
    const textEvent: LoopEvent = {
      type: 'text', seq: 9, ts: 9, turn: 1, preview: 'all tests passed!',
    };
    const events: LoopEvent[] = [textEvent];
    expect(classifyCodeChecks(events, { runId: 'r' })).toHaveLength(0);
  });

  it('maps still-running classified checks to cancelled on user abort (M2)', () => {
    const abort: AbortedEvent = {
      type: 'aborted', seq: 9, ts: 9, reason: 'user',
    };
    const events: LoopEvent[] = [
      toolUse('a', 'Bash', 'pnpm test'),
      abort,
      toolResult('a', true),
    ];
    const checks = classifyCodeChecks(events, { runId: 'r' });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('cancelled');
  });

  it('maps still-running classified checks to cancelled on timeout (M2)', () => {
    const abort: AbortedEvent = {
      type: 'aborted', seq: 9, ts: 9, reason: 'timeout',
    };
    const events: LoopEvent[] = [toolUse('b', 'Bash', 'cargo test'), abort];
    expect(classifyCodeChecks(events, { runId: 'r' })[0]?.status).toBe('cancelled');
  });

  it('error aborts do not fabricate cancelled checks (M2)', () => {
    const abort: AbortedEvent = {
      type: 'aborted', seq: 9, ts: 9, reason: 'error',
    };
    const events: LoopEvent[] = [toolUse('c', 'Bash', 'npm test'), abort];
    expect(classifyCodeChecks(events, { runId: 'r' })).toHaveLength(0);
  });
});