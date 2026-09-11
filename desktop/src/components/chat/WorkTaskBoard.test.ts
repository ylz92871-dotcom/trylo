import { describe, expect, it } from 'vitest';
import { workPausePrompt } from './WorkTaskBoard';
import type { WorkNarrationLine } from './types';

function narration(id: string, text: string): WorkNarrationLine {
  return {
    id,
    kind: 'work_narration',
    role: 'assistant',
    createdAt: 1,
    runId: 'run-1',
    text,
    phaseId: 'execute',
  };
}

describe('workPausePrompt', () => {
  it('keeps the actionable shell question instead of the generic paused marker', () => {
    expect(workPausePrompt([
      narration(
        'question',
        'This task requires running commands, but Shell access is currently disabled. Reply "enable shell" to continue.',
      ),
      narration('paused', 'Paused - awaiting user input'),
    ])).toContain('enable shell');
  });

  it('surfaces an ordinary actionable question verbatim', () => {
    expect(workPausePrompt([
      narration('question', '请选择需要处理的文件？'),
      narration('paused', '等待用户输入'),
    ])).toBe('请选择需要处理的文件？');
  });

  it('falls back to a clear continuation hint when no question was recorded', () => {
    expect(workPausePrompt([
      narration('paused', 'Paused - awaiting user input'),
    ])).toContain('下方输入');
  });
});
