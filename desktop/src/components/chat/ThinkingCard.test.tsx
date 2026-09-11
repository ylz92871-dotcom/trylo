// Trylo Desktop — ThinkingCard component tests (spec §11.4).
//
// §11.4: `aria-expanded` must stay in sync with the visual
// disclosure state, and the per-phase card behavior must be
// source-agnostic (Code or Work). The card also hides the
// run-activity line once the card freezes (`partial:false`).

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { ThinkingCard } from './ThinkingCard';
import type { ThinkingMessage } from './types';

function thinking(over: Partial<ThinkingMessage>): ThinkingMessage {
  return {
    id: 'th1',
    kind: 'thinking',
    role: 'assistant',
    createdAt: 1000,
    turnId: 'u1',
    summary: 'Analyzing',
    preview: 'Looking at the request…',
    fullLength: 24,
    partial: true,
    turn: 1,
    ...over,
  };
}

describe('ThinkingCard disclosure (§11.4)', () => {
  it('defaults to collapsed with aria-expanded in sync', () => {
    render(<ThinkingCard message={thinking({})} isTurnActive />);
    const head = screen.getByRole('button');
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head.parentElement!.querySelector('.disclosure')).not.toHaveClass(
      'disclosure--open',
    );
  });

  it('click toggles aria-expanded and the visual disclosure together', () => {
    render(<ThinkingCard message={thinking({})} isTurnActive />);
    const head = screen.getByRole('button');
    fireEvent.click(head);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(head.parentElement!.querySelector('.disclosure')).toHaveClass(
      'disclosure--open',
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(head.parentElement!.querySelector('.disclosure')).not.toHaveClass(
      'disclosure--open',
    );
  });
});

describe('ThinkingCard activity line (Work phase card, §11.4)', () => {
  it('shows the run activity while the card is still streaming', () => {
    render(
      <ThinkingCard
        message={thinking({ partial: true, activity: 'Running step 2…' })}
        isTurnActive
      />,
    );
    expect(screen.getByText('Running step 2…')).toBeTruthy();
  });

  it('drops the activity line once the card freezes (partial:false)', () => {
    const { rerender } = render(
      <ThinkingCard
        message={thinking({ partial: true, activity: 'Running step 2…' })}
        isTurnActive
      />,
    );
    expect(screen.getByText('Running step 2…')).toBeTruthy();
    rerender(
      <ThinkingCard
        message={thinking({ partial: false, activity: 'Running step 2…' })}
        isTurnActive={false}
      />,
    );
    expect(screen.queryByText('Running step 2…')).toBeNull();
  });
});
