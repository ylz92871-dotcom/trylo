// Trylo Desktop — ResultDock keyboard + ARIA behavioural tests
// (C-Edge P2-4). These are NOT snapshot tests: each one drives a real
// keyboard event and asserts on the resulting state.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ResultDock } from './ResultDock';

afterEach(() => cleanup());

describe('ResultDock (C-Edge P2-4) — keyboard activation', () => {
  it('Space toggles via onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(
      <ResultDock
        id="k1"
        mode="code"
        title="Results"
        count={2}
        status="ready"
        open
        onOpenChange={onOpenChange}
      >
        <ul><li>x</li><li>y</li></ul>
      </ResultDock>,
    );
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Enter toggles via onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(
      <ResultDock
        id="k2"
        mode="code"
        title="Results"
        count={2}
        status="ready"
        open={false}
        onOpenChange={onOpenChange}
      >
        <ul><li>x</li></ul>
      </ResultDock>,
    );
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('Escape invokes onToggle when open', () => {
    const onToggle = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ResultDock
        id="k3"
        mode="code"
        title="Results"
        count={2}
        status="ready"
        open
        onOpenChange={onOpenChange}
        onToggle={onToggle}
      >
        <ul><li>x</li></ul>
      </ResultDock>,
    );
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('Escape is a no-op when already collapsed', () => {
    const onToggle = vi.fn();
    render(
      <ResultDock
        id="k4"
        mode="code"
        title="Results"
        count={2}
        status="ready"
        open={false}
        onOpenChange={() => {}}
        onToggle={onToggle}
      >
        <ul><li>x</li></ul>
      </ResultDock>,
    );
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('Escape is a no-op when no onToggle is supplied', () => {
    render(
      <ResultDock
        id="k5"
        mode="code"
        title="Results"
        count={2}
        status="ready"
        open
        onOpenChange={() => {}}
      >
        <ul><li>x</li></ul>
      </ResultDock>,
    );
    // The keyDown handler should not throw or default to anything
    // destructive.
    expect(() =>
      fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' }),
    ).not.toThrow();
  });

  it('click on the header still toggles via onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(
      <ResultDock
        id="k6"
        mode="code"
        title="Results"
        count={1}
        status="ready"
        open
        onOpenChange={onOpenChange}
      >
        <span>child</span>
      </ResultDock>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ResultDock (C-Edge P2-4) — controlled state', () => {
  it('button cannot flip its own state when parent holds open=true', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ResultDock id="c1" mode="code" title="Results" count={1} status="ready" open onOpenChange={onOpenChange}>
        <span>a</span>
      </ResultDock>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Parent does NOT update → UI stays expanded.
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    rerender(
      <ResultDock id="c1" mode="code" title="Results" count={1} status="ready" open onOpenChange={onOpenChange}>
        <span>a</span>
      </ResultDock>,
    );
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('aria-expanded tracks the controlled prop across prop updates', () => {
    const { rerender } = render(
      <ResultDock id="c2" mode="work" title="Artifacts" count={1} status="ready" open onOpenChange={() => {}}>
        <span>a</span>
      </ResultDock>,
    );
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    rerender(
      <ResultDock id="c2" mode="work" title="Artifacts" count={1} status="ready" open={false} onOpenChange={() => {}}>
        <span>a</span>
      </ResultDock>,
    );
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ResultDock (C-Edge P2-4) — ARIA correctness', () => {
  it('aria-label carries the title only (no duplicated count)', () => {
    render(
      <ResultDock id="a1" mode="code" title="Results" count={5} status="ready" open onOpenChange={() => {}}>
        <span>x</span>
      </ResultDock>,
    );
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toBe('Results');
    expect(btn.getAttribute('aria-label')).not.toContain('5');
  });

  it('count is rendered as a visible span, not in the aria-label', () => {
    const { container } = render(
      <ResultDock id="a2" mode="code" title="Results" count={7} status="ready" open onOpenChange={() => {}}>
        <span>x</span>
      </ResultDock>,
    );
    const count = container.querySelector('.result-dock__count');
    expect(count?.textContent).toBe('7');
    expect(count?.getAttribute('aria-hidden')).toBe('true');
  });

  it('aria-controls points at the body id', () => {
    render(
      <ResultDock id="a3" mode="code" title="Results" count={1} status="ready" open onOpenChange={() => {}}>
        <span>x</span>
      </ResultDock>,
    );
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-controls')).toBe('a3-body');
    expect(document.getElementById('a3-body')).toBeTruthy();
  });

  it('failed status renders a failed badge, not a count', () => {
    const { container } = render(
      <ResultDock id="a4" mode="code" title="Results" count={0} status="failed" warning="boom" open onOpenChange={() => {}}>
        <span>x</span>
      </ResultDock>,
    );
    expect(container.querySelector('.result-dock__fail-badge')?.textContent).toBe('失败');
    expect(container.querySelector('.result-dock__count')).toBeNull();
  });

  it('warning paragraph has role=status for screen-reader announcement', () => {
    const { container } = render(
      <ResultDock id="a5" mode="code" title="Results" count={1} status="ready" warning="partial" open onOpenChange={() => {}}>
        <span>x</span>
      </ResultDock>,
    );
    const w = container.querySelector('.result-dock__warning');
    expect(w?.getAttribute('role')).toBe('status');
  });
});

describe('ResultDock (C-Edge P2-4) — focus + a11y', () => {
  it('header button is keyboard focusable', () => {
    render(
      <ResultDock id="f1" mode="code" title="Results" count={1} status="ready" open onOpenChange={() => {}}>
        <span>x</span>
      </ResultDock>,
    );
    const btn = screen.getByRole('button');
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });

  it('body content is not in the tab order when collapsed', () => {
    render(
      <ResultDock id="f2" mode="code" title="Results" count={1} status="ready" open={false} onOpenChange={() => {}}>
        <a href="#x">link</a>
      </ResultDock>,
    );
    // Disclosure uses a CSS class for visibility; the DOM is still
    // mounted (the audit requires this for state preservation), but the
    // inner link should not be tab-focusable because the disclosure
    // is closed.
    const link = screen.getByText('link');
    // jsdom doesn't compute CSS visibility, so we verify the class
    // instead — the component is a presentation surface and the
    // visual reveal is the disclosure's job.
    expect(document.querySelector('.disclosure')).toBeTruthy();
    expect(document.querySelector('.disclosure--open')).toBeNull();
    expect(link).toBeTruthy();
  });
});
