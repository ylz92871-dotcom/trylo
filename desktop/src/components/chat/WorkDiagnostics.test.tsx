// Trylo Desktop — WorkDiagnostics drawer tests
// (M3 closure spec §10.2, fixing M3-P1-07 / M3-P2-03).
//
// The drawer must be usable with ZERO events: it opens,
// shows the connection state + last connection error,
// and its search locates an ErrorCard's diagnosticId
// exactly.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkDiagnostics, type DaemonEventLine } from '@trylo/work';

function line(over: Partial<DaemonEventLine> = {}): DaemonEventLine {
  return {
    id: 'frame:t:timeline_step_updated:1',
    at: 1_700_000_000_000,
    event: 'task.event',
    summary: 'task.event timeline_step_updated',
    routeDecision: 'task_notice',
    severity: 'info',
    ...over,
  };
}

function open(props: Parameters<typeof WorkDiagnostics>[0]) {
  render(<WorkDiagnostics {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Diagnostics/ }));
}

describe('WorkDiagnostics zero-event visibility (§10.2, M3-P1-07)', () => {
  it('toggle is ENABLED with zero events', () => {
    render(<WorkDiagnostics daemonEvents={[]} connectionStatus="error" />);
    const toggle = screen.getByRole('button', { name: /Diagnostics/ }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
  });

  it('opens with zero events and shows connection error + retry hint', () => {
    open({
      daemonEvents: [],
      connectionStatus: 'error',
      connectionError: 'connection refused',
    });
    expect(screen.getByText(/control plane: error/)).toBeTruthy();
    expect(screen.getByText('connection refused')).toBeTruthy();
    expect(screen.getByText(/自动重试/)).toBeTruthy();
    expect(screen.getByText(/尚无事件记录/)).toBeTruthy();
  });

  it('connected + zero events shows the empty state, no error text', () => {
    open({ daemonEvents: [], connectionStatus: 'connected' });
    expect(screen.getByText(/control plane: connected/)).toBeTruthy();
    expect(screen.queryByText(/自动重试/)).toBeNull();
  });
});

describe('WorkDiagnostics search correlation (§10.2)', () => {
  it('locates exactly the record carrying the ErrorCard diagnosticId', () => {
    const errorLine = line({
      id: 'err-m3x-1',
      routeDecision: 'task_error',
      severity: 'error',
      summary: 'quota exceeded',
      normalizedError: { code: 'timeline_error', userMessage: 'quota exceeded' },
    });
    open({
      daemonEvents: [errorLine, line()],
      connectionStatus: 'connected',
    });
    // Both records visible before filtering.
    expect(screen.getByText('task_error')).toBeTruthy();
    expect(screen.getByText('task_notice')).toBeTruthy();
    fireEvent.change(
      screen.getByRole('searchbox', { name: /Filter diagnostics/ }),
      { target: { value: 'err-m3x-1' } },
    );
    expect(screen.getByText('task_error')).toBeTruthy();
    expect(screen.queryByText('task_notice')).toBeNull();
  });

  it('shows an explicit empty result for a non-matching query', () => {
    open({ daemonEvents: [line()], connectionStatus: 'connected' });
    fireEvent.change(
      screen.getByRole('searchbox', { name: /Filter diagnostics/ }),
      { target: { value: 'does-not-exist' } },
    );
    expect(screen.getByText(/没有匹配的诊断记录/)).toBeTruthy();
  });

  it('expanding a record reveals identity + redacted payload', () => {
    open({
      daemonEvents: [
        line({
          taskId: 'task-1',
          runId: 'work-run-task-1',
          eventType: 'timeline_step_updated',
          rawPayloadRedacted: '{"output":"<redacted 500 chars>"}',
        }),
      ],
      connectionStatus: 'connected',
    });
    fireEvent.click(screen.getByRole('button', { name: /task\.event/ }));
    expect(screen.getByText('work-run-task-1')).toBeTruthy();
    expect(screen.getByText(/<redacted 500 chars>/)).toBeTruthy();
  });
});
