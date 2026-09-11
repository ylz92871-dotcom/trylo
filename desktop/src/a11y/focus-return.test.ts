// Trylo Desktop — focus-return utility tests (C-Edge P2-4 a11y).

import { afterEach, describe, expect, it } from 'vitest';
import { captureFocus, resetCapturedFocus, restoreFocus } from './focus-return';

afterEach(() => {
  resetCapturedFocus();
  document.body.innerHTML = '';
});

describe('focus-return', () => {
  it('restores focus to the element captured by captureFocus', () => {
    const button = document.createElement('button');
    button.textContent = 'open';
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    captureFocus();
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);

    restoreFocus();
    expect(document.activeElement).toBe(button);
  });

  it('no-op when nothing was captured', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(() => restoreFocus()).not.toThrow();
  });

  it('clears the snapshot after restoring once', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    captureFocus();
    restoreFocus();
    // second restore must not throw
    expect(() => restoreFocus()).not.toThrow();
  });

  it('skips restore when the captured element is no longer in the DOM', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    captureFocus();
    button.remove();
    document.body.appendChild(document.createElement('input')).focus();
    expect(() => restoreFocus()).not.toThrow();
  });
});
