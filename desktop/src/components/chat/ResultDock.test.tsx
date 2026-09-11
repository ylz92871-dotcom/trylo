// Trylo Desktop — ResultDock (P2-1, spec §12.2 / C-Edge P2-4).
//
// The shared result-summary shell. Pins: null when there is nothing to
// show; warning-only visibility; aria-expanded ↔ .disclosure--open; body
// stays mounted when collapsed; count is the real total; Code and Work
// share the same shell class. C-Edge P2-4: the dock is fully
// controlled — `open` / `onOpenChange` are required props.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ResultDock } from './ResultDock';

afterEach(() => cleanup());

describe('ResultDock (P2-1) — basic shell behaviour', () => {
  it('renders nothing when idle, ready, zero-count and no warning', () => {
    const { container } = render(
      <ResultDock
        id="r1"
        mode="work"
        title="Artifacts"
        count={0}
        status="ready"
        open
        onOpenChange={() => {}}
      >
        <ul><li>child</li></ul>
      </ResultDock>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a warning-only dock when status is failed (with retry)', () => {
    const onRefresh = vi.fn();
    render(
      <ResultDock
        id="r2"
        mode="code"
        title="Results"
        count={0}
        status="failed"
        warning="Scan failed"
        open
        onOpenChange={() => {}}
        onRefresh={onRefresh}
      >
        <span>nothing</span>
      </ResultDock>,
    );
    expect(screen.getByText('Scan failed')).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders a warning-only ready dock when a warning exists', () => {
    render(
      <ResultDock
        id="r3"
        mode="work"
        title="Artifacts"
        count={0}
        status="ready"
        warning="Partial scan"
        open
        onOpenChange={() => {}}
      >
        <span>body</span>
      </ResultDock>,
    );
    expect(screen.getByText('Partial scan')).toBeTruthy();
    expect(screen.getByText('body')).toBeTruthy();
  });

  it('aria-expanded stays in sync with .disclosure--open', () => {
    const { container } = render(
      <ResultDock id="r4" mode="code" title="Results" count={3} status="ready" open onOpenChange={() => {}}>
        <ul><li>a</li><li>b</li><li>c</li></ul>
      </ResultDock>,
    );
    const head = screen.getByRole('button');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.disclosure--open')).toBeTruthy();
  });

  it('keeps the body mounted when collapsed (parent-controlled)', () => {
    render(
      <ResultDock id="r5" mode="code" title="Results" count={1} status="ready" open={false} onOpenChange={() => {}}>
        <span>persisted-child</span>
      </ResultDock>,
    );
    expect(screen.getByText('persisted-child')).toBeTruthy();
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  it('Code and Work share the same shell class', () => {
    render(
      <ResultDock id="c" mode="code" title="Results" count={1} status="ready" open onOpenChange={() => {}}>
        <span>c</span>
      </ResultDock>,
    );
    render(
      <ResultDock id="w" mode="work" title="Artifacts" count={1} status="ready" open onOpenChange={() => {}}>
        <span>w</span>
      </ResultDock>,
    );
    expect(document.querySelectorAll('.result-dock').length).toBe(2);
  });
});
