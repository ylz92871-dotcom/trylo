// Trylo Desktop — WorkWorkflowCard component tests.
//
// Covers the four render states (running, completed,
// failed phase, future/pending) plus the activity click
// callback. Snapshot-free: assertions are on visible text
// and ARIA attributes so refactors of the markup don't
// require a global snapshot update.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { WorkWorkflowCard } from './WorkWorkflowCard';
import type {
  WorkflowActivity,
  WorkflowMessage,
  WorkflowPhase,
} from './types';

function makeActivity(
  partial: Partial<WorkflowActivity> & Pick<WorkflowActivity, 'id' | 'kind'>,
): WorkflowActivity {
  return {
    label: `act-${partial.id}`,
    status: 'completed',
    at: 1000,
    ...partial,
  };
}

function makePhase(
  partial: Partial<WorkflowPhase> & Pick<WorkflowPhase, 'id' | 'title'>,
): WorkflowPhase {
  return {
    status: 'pending',
    activities: [],
    ...partial,
  };
}

function makeWorkflow(
  partial: Partial<WorkflowMessage> & Pick<WorkflowMessage, 'runId'>,
): WorkflowMessage {
  return {
    id: 'workflow:run-1',
    kind: 'workflow',
    role: 'assistant',
    createdAt: 1000,
    workflowId: 'workflow:run-1',
    status: 'running',
    phases: [],
    ...partial,
  };
}

describe('WorkWorkflowCard: running workflow', () => {
  it('renders head with current phase expanded and 3 recent activities', () => {
    const wf = makeWorkflow({
      runId: 'run-1',
      status: 'running',
      phases: [
        makePhase({ id: 'g1', title: 'DISCOVER', status: 'completed' }),
        makePhase({
          id: 'g2',
          title: 'BUILD',
          status: 'active',
          activities: [
            makeActivity({ id: 'a1', kind: 'tool', toolMessageId: 'tm-1' }),
            makeActivity({ id: 'a2', kind: 'tool', toolMessageId: 'tm-2' }),
            makeActivity({ id: 'a3', kind: 'thinking' }),
            makeActivity({ id: 'a4', kind: 'notice' }),
          ],
        }),
        makePhase({ id: 'g3', title: 'VERIFY', status: 'pending' }),
      ],
    });
    const { container } = render(<WorkWorkflowCard message={wf} />);
    expect(container.textContent).toContain('进行中');
    expect(container.textContent).toContain('1 / 3 阶段');
    // The "recent 3" are the last 3 of the 4 activities:
    // a2, a3, a4. a1 falls into the overflow.
    expect(container.textContent).toContain('act-a2');
    expect(container.textContent).toContain('act-a3');
    expect(container.textContent).toContain('act-a4');
    expect(container.textContent).not.toContain('act-a1');
    expect(container.textContent).toContain('展开剩余 1 个活动');
  });
});

describe('WorkWorkflowCard: completed workflow', () => {
  it('renders one-line summary with expand affordance', () => {
    const wf = makeWorkflow({
      runId: 'run-2',
      status: 'completed',
      phases: [
        makePhase({ id: 'g1', title: 'DISCOVER', status: 'completed' }),
        makePhase({ id: 'g2', title: 'BUILD', status: 'completed' }),
      ],
    });
    const { container } = render(<WorkWorkflowCard message={wf} />);
    expect(container.textContent).toContain('已完成');
    // The disclosure body is collapsed (no `disclosure--open`
    // class) by default for a terminal workflow.
    const disclosure = container.querySelector('.work-workflow .disclosure');
    expect(disclosure).toBeTruthy();
    expect(disclosure?.classList.contains('disclosure--open')).toBe(false);
    // Click the head to expand and see the phases.
    fireEvent.click(container.querySelector('.work-workflow__head') as HTMLElement);
    expect(
      container.querySelector('.work-workflow .disclosure')
        ?.classList.contains('disclosure--open'),
    ).toBe(true);
    expect(container.textContent).toContain('DISCOVER');
    expect(container.textContent).toContain('BUILD');
  });
});

describe('WorkWorkflowCard: failed phase', () => {
  it('is force-expanded and shows danger color', () => {
    const wf = makeWorkflow({
      runId: 'run-3',
      status: 'failed',
      phases: [
        makePhase({
          id: 'g1',
          title: 'BUILD',
          status: 'failed',
          activities: [makeActivity({ id: 'a1', kind: 'tool' })],
        }),
      ],
    });
    const { container } = render(<WorkWorkflowCard message={wf} />);
    // A failed (terminal) workflow is collapsed by default;
    // expand the head first, then the failed phase auto-
    // expands and its activity is visible.
    fireEvent.click(container.querySelector('.work-workflow__head') as HTMLElement);
    expect(container.textContent).toContain('act-a1');
    // The failed phase carries the danger modifier class.
    const failed = container.querySelector('.work-workflow__phase--failed');
    expect(failed).toBeTruthy();
  });
});

describe('WorkWorkflowCard: activity click', () => {
  it('clicking an activity with toolMessageId calls onOpenActivity', () => {
    const onOpen = vi.fn();
    const wf = makeWorkflow({
      runId: 'run-4',
      status: 'running',
      phases: [
        makePhase({
          id: 'g1',
          title: 'BUILD',
          status: 'active',
          activities: [
            makeActivity({ id: 'a1', kind: 'tool', toolMessageId: 'tm-1' }),
          ],
        }),
      ],
    });
    const { container } = render(
      <WorkWorkflowCard message={wf} onOpenActivity={onOpen} />,
    );
    // Activities are now <button> elements; find the one
    // that owns the activity text.
    const activityBtn = Array.from(
      container.querySelectorAll('.work-workflow__activity-btn'),
    ).find((el) => el.textContent?.includes('act-a1'));
    expect(activityBtn).toBeTruthy();
    fireEvent.click(activityBtn as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('tm-1');
  });

  it('clicking a thinking activity (no toolMessageId) is a no-op', () => {
    const onOpen = vi.fn();
    const wf = makeWorkflow({
      runId: 'run-5',
      status: 'running',
      phases: [
        makePhase({
          id: 'g1',
          title: 'BUILD',
          status: 'active',
          activities: [makeActivity({ id: 'a1', kind: 'thinking' })],
        }),
      ],
    });
    const { container } = render(
      <WorkWorkflowCard message={wf} onOpenActivity={onOpen} />,
    );
    // A thinking activity is rendered as a disabled button
    // (no toolMessageId, so no click handler). The click
    // should be a no-op.
    const buttons = container.querySelectorAll('.work-workflow__activity-btn');
    expect(buttons.length).toBe(1);
    const btn = buttons[0] as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('WorkWorkflowCard: pending phase', () => {
  it('renders future phases with low-emphasis style', () => {
    const wf = makeWorkflow({
      runId: 'run-6',
      status: 'running',
      phases: [
        makePhase({ id: 'g1', title: 'DISCOVER', status: 'completed' }),
        makePhase({ id: 'g2', title: 'FUTURE', status: 'pending' }),
      ],
    });
    const { container } = render(<WorkWorkflowCard message={wf} />);
    // The pending phase has the modifier class.
    const phase = container.querySelector('.work-workflow__phase--pending');
    expect(phase).toBeTruthy();
  });
});
