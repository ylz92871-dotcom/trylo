import { expect, it } from 'vitest';
import { codeApprovalMessages } from './code-approval-messages';
import type { CodePermissionRequest } from '../../runtime/code-permission-registry';
import { createElement } from 'react';
import { act, render, screen } from '@testing-library/react';
import { useCodeApprovals } from './code-approval-messages';

const request = (projectKey: string, requestId: string): CodePermissionRequest => ({
  requestId, processId: `root-${projectKey}`, projectKey, conversationId: 'same-conversation',
  toolName: 'write_file', input: { path: 'proof.txt' }, at: 1,
});

it('keeps identical conversation ids in different projects from sharing approval cards', () => {
  const cards = codeApprovalMessages([request('a', 'approval-a'), request('b', 'approval-b')], 'b', 'same-conversation');
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ approvalId: 'approval-b', pendingRequest: { processId: 'root-b', projectKey: 'b' } });
});

it('projects registry changes for Work without requiring a Code controller or a Code-view transition', () => {
  let pending: CodePermissionRequest[] = []; let version = 0;
  const listeners = new Set<() => void>();
  const source = { pendingCodePermissions: () => pending, getVersion: () => version,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const update = (requests: CodePermissionRequest[]) => { pending = requests; version += 1; for (const notify of listeners) notify(); };
  function WorkApprovalView() {
    const cards = useCodeApprovals(source, 'work-project', 'same-conversation');
    return createElement('div', { 'data-testid': 'work-approvals' }, cards.map(card => card.id).join(','));
  }
  const view = render(createElement(WorkApprovalView));
  try {
    expect(screen.getByTestId('work-approvals').textContent).toBe('');
    act(() => update([request('work-project', 'work-approval')]));
    expect(screen.getByTestId('work-approvals').textContent).toContain('work-approval');
    act(() => update([]));
    expect(screen.getByTestId('work-approvals').textContent).toBe('');
  } finally { view.unmount(); }
});
