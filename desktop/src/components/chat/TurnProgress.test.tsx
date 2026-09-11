// Trylo Desktop — TurnProgress component tests (spec §11.4).
//
// §11.4: the row must appear the moment the user sends —
// even before any runtime output — and turn static once the
// first meaningful output freezes the timer (spec §6.2).

import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { TurnProgress } from './TurnProgress';

describe('TurnProgress timing (§11.4 / §6.2)', () => {
  it('appears immediately after send as a live but visually static timer', () => {
    const started = Date.now() - 5000;
    const { container } = render(
      <TurnProgress turnStartedAt={started} isActive />,
    );
    const row = container.querySelector('.turn-progress');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('role')).toBe('status');
    // Live counter without the "已工作" freeze prefix.
    expect(container.textContent).toBe('0:05');
    // The newest timeline footer owns startup motion; this historical row is
    // deliberately static so the screen never has two competing loops.
    expect(container.querySelector('.turn-progress__logo--spin')).toBeNull();
  });

  it('freezes to "已工作" once the first output lands (finalElapsedMs set)', () => {
    const { container } = render(
      <TurnProgress turnStartedAt={1000} finalElapsedMs={12000} isActive={false} />,
    );
    expect(container.textContent).toBe('已工作 0:12');
    // No animation in the frozen state.
    expect(container.querySelector('.turn-progress__logo--spin')).toBeNull();
  });

  it('renders nothing when there is no recorded send time (history)', () => {
    const { container } = render(
      <TurnProgress turnStartedAt={null} isActive={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('an inactive turn is a static label, never a spinning logo', () => {
    const started = Date.now() - 1000;
    const { container } = render(
      <TurnProgress turnStartedAt={started} isActive={false} />,
    );
    expect(container.querySelector('.turn-progress__logo--spin')).toBeNull();
    // Static freeze-form label for a turn that isn't the active one.
    expect(container.textContent).toMatch(/^已工作 0:0[01]$/);
  });
});
