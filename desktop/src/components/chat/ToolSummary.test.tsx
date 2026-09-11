// Trylo Desktop — ToolSummary component tests (spec §11.4).
//
// The phase summary chip: aria-expanded in sync with the
// visual disclosure state, correct count + breakdown text,
// and nothing rendered when there are no tools.

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { ToolSummary } from './ToolSummary';
import type { ToolMessage } from './types';

function tool(id: string, name: string, status: ToolMessage['status'] = 'done'): ToolMessage {
  return {
    id,
    kind: 'tool',
    role: 'assistant',
    createdAt: 1000,
    turnId: 'u1',
    tool: name,
    summary: `${name} ${id}`,
    status,
  };
}

describe('ToolSummary disclosure (§11.4)', () => {
  it('renders nothing when there are no tools', () => {
    const { container } = render(<ToolSummary tools={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count and the kind breakdown', () => {
    render(
      <ToolSummary
        tools={[tool('t1', 'Read'), tool('t2', 'Read'), tool('t3', 'Bash')]}
      />,
    );
    expect(screen.getByText('Ran 3 tools')).toBeTruthy();
    expect(screen.getByText('Read × 2 · Bash × 1')).toBeTruthy();
  });

  it('singular wording for a single tool', () => {
    render(<ToolSummary tools={[tool('t1', 'Read')]} />);
    expect(screen.getByText('Ran 1 tool')).toBeTruthy();
  });

  it('collapsed by default, aria-expanded in sync with the disclosure', () => {
    const { container } = render(<ToolSummary tools={[tool('t1', 'Read')]} />);
    // The summary head — the ToolCard heads inside the list
    // are also buttons, so scope to the summary head.
    const head = container.querySelector<HTMLButtonElement>('.tool-summary__head')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.parentElement!.querySelector('.disclosure')).not.toHaveClass(
      'disclosure--open',
    );
    // The tool list stays MOUNTED inside the shared
    // `.disclosure` grid row (spec §7.4) — "collapsed" is
    // the grid row at 0fr + opacity 0, not an unmount.
    expect(container.querySelector('.tool-summary__list')).not.toBeNull();
  });

  it('expanding reveals the tool cards and syncs the visual state', () => {
    const { container } = render(
      <ToolSummary
        tools={[tool('t1', 'Read'), tool('t2', 'Bash', 'done')]}
      />,
    );
    const head = container.querySelector<HTMLButtonElement>('.tool-summary__head')!;
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(head.parentElement!.querySelector('.disclosure')).toHaveClass(
      'disclosure--open',
    );
    expect(screen.getByText('Read t1')).toBeTruthy();
    expect(screen.getByText('Bash t2')).toBeTruthy();
  });
});
