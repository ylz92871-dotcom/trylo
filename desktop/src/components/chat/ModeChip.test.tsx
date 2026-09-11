// Trylo Desktop — ModeChip test. See v1.16.1.

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ModeChip } from './ModeChip';

describe('ModeChip', () => {
  it('renders the current mode label + icon', () => {
    render(
      <ModeChip current="agent" onChange={vi.fn()} onApplyPlan={vi.fn()} />,
    );
    const btn = screen.getByRole('button', { name: /agent/i });
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toContain('Agent');
    expect(btn.textContent).toContain('⚡'); // agent icon
  });

  it('uses a different tier class per mode', () => {
    const { container, rerender } = render(
      <ModeChip current="agent" onChange={vi.fn()} onApplyPlan={vi.fn()} />,
    );
    expect(container.querySelector('.mode-chip')!.className).toContain(
      'mode-chip--agent',
    );

    rerender(
      <ModeChip current="plan" onChange={vi.fn()} onApplyPlan={vi.fn()} />,
    );
    expect(container.querySelector('.mode-chip')!.className).toContain(
      'mode-chip--plan',
    );

    rerender(
      <ModeChip current="chat" onChange={vi.fn()} onApplyPlan={vi.fn()} />,
    );
    expect(container.querySelector('.mode-chip')!.className).toContain(
      'mode-chip--chat',
    );

    rerender(
      <ModeChip current="cognition" onChange={vi.fn()} onApplyPlan={vi.fn()} />,
    );
    expect(container.querySelector('.mode-chip')!.className).toContain(
      'mode-chip--cognition',
    );
  });

  it('shows the apply-plan button only in plan mode', () => {
    const { container, rerender } = render(
      <ModeChip current="agent" onChange={vi.fn()} onApplyPlan={vi.fn()} />,
    );
    expect(container.querySelector('.mode-chip__apply')).toBeNull();

    rerender(
      <ModeChip current="chat" onChange={vi.fn()} onApplyPlan={vi.fn()} />,
    );
    expect(container.querySelector('.mode-chip__apply')).toBeNull();

    rerender(
      <ModeChip current="plan" onChange={vi.fn()} onApplyPlan={vi.fn()} />,
    );
    expect(container.querySelector('.mode-chip__apply')).not.toBeNull();
  });

  it('fires onApplyPlan when the apply button is clicked', () => {
    const onApplyPlan = vi.fn();
    render(
      <ModeChip current="plan" onChange={vi.fn()} onApplyPlan={onApplyPlan} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /apply plan/i }));
    expect(onApplyPlan).toHaveBeenCalledTimes(1);
  });

  it('opens the ModePopover on chip click, then closes on select', () => {
    const onChange = vi.fn();
    render(
      <ModeChip current="agent" onChange={onChange} onApplyPlan={vi.fn()} />,
    );
    // Popover not visible initially.
    expect(screen.queryByRole('listbox')).toBeNull();
    // Click the chip to open the popover.
    fireEvent.click(screen.getByRole('button', { name: /agent/i }));
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    // Select a different mode (plan).
    fireEvent.click(screen.getByRole('option', { name: /plan/i }));
    expect(onChange).toHaveBeenCalledWith('plan');
    // Popover closes.
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
