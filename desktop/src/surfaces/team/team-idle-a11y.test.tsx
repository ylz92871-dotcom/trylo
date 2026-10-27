import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { TeamIdle } from './composer/TeamIdle';

describe('team template actions', () => {
  it('exposes templates as named buttons inside their list', () => {
    const open = vi.fn();
    render(<TeamIdle composerLive onOpenComposer={open} />);
    const button = screen.getByRole('button', { name: /实现小改动/ });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith('small-change');
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });
});
