import { fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { StreamTranslator } from '../../host-adapter/stream-translator';
import { applyEvents } from './events';
import { computeFileChanges } from './file-change';
import { CodeReasoningTranscript } from './CodeReasoningTranscript';
import type { ToolMessage } from './types';

describe('legacy file diff delivery', () => {
  it('carries actual shell receipts through translation, reducer and visible red/green UI', () => {
    const translator = new StreamTranslator();
    const start = translator.feed(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'shell-edit', name: 'Bash', input: { command: 'python script.py' } },
    ] } }));
    const result = translator.feed(JSON.stringify({ type: 'user',
      tool_use_result: { tryloFileChanges: [{ path: '/external/今日夸夸.html', kind: 'patched',
        preview: '--- a\n+++ b\n@@ -1 +1 @@\n-before\n+after\n', truncated: false }] },
      message: { content: [{ type: 'tool_result', tool_use_id: 'shell-edit', content: '', is_error: false }] } }));
    const messages = applyEvents([], [...start, ...result]);
    const tool = messages.find(message => message.kind === 'tool') as ToolMessage;
    expect(computeFileChanges(tool.tool, tool.input, tool.outputContent)[0]).toMatchObject({ additions: 1, deletions: 1, basis: 'result' });
    const view = render(<CodeReasoningTranscript entries={[tool]} active turnId="u" phaseId="p" />);
    expect(view.container.querySelector('[data-testid="file-change-card"]')).toBeVisible();
    expect(view.container.querySelector('.fchange__diff-line--del')).toHaveTextContent('before');
    expect(view.container.querySelector('.fchange__diff-line--add')).toHaveTextContent('after');
    fireEvent.click(view.container.querySelector('.fchange__head')!);
    expect(view.container.querySelector('.fchange__head')).toHaveAttribute('aria-expanded', 'false');
  });
  it('does not invent a change from shell text or an invalid receipt', () => {
    expect(computeFileChanges('Bash', { command: 'echo file changed +3 -1' })).toEqual([]);
    const translator = new StreamTranslator();
    const events = translator.feed(JSON.stringify({ type: 'user', tool_use_result: { tryloFileChanges: [{ path: '', kind: 'patched' }] },
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file changed' }] } }));
    const result = events.find(event => event.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.content?.some(block => block.type === 'structured')).toBeFalsy();
  });
});
