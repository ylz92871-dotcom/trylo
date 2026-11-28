import { describe, expect, it } from 'vitest';
import {
  formatShortcut,
  isImeComposing,
  isMacPlatform,
  isPrimaryModKey,
  isWindowsPlatform,
} from './platform';

describe('platform helpers', () => {
  it('detects macOS from navigator platform or Macintosh userAgent without false-matching darwin jsdom', () => {
    expect(isMacPlatform({ platform: 'MacIntel', userAgent: '' })).toBe(true);
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })).toBe(true);
    expect(
      isMacPlatform({
        platform: '',
        userAgent: 'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/24.0.0',
      }),
    ).toBe(false);
    expect(isMacPlatform({ platform: 'Win32', userAgent: 'Windows NT 10.0' })).toBe(false);
  });

  it('detects Windows from platform or userAgent', () => {
    expect(isWindowsPlatform({ platform: 'Win32', userAgent: '' })).toBe(true);
    expect(isWindowsPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64)' })).toBe(true);
    expect(isWindowsPlatform({ platform: 'MacIntel', userAgent: '' })).toBe(false);
  });

  it('recognizes either metaKey or ctrlKey as primary mod key', () => {
    expect(isPrimaryModKey({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPrimaryModKey({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPrimaryModKey({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  describe('formatShortcut', () => {
    const mac = { platform: 'MacIntel' };
    const win = { platform: 'Win32' };
    const linux = { platform: 'Linux x86_64' };

    it('sorts macOS modifiers in strict Apple HIG order ⌃⌥⇧⌘ with no separators', () => {
      expect(formatShortcut(['Mod', 'F'], mac)).toBe('⌘F');
      expect(formatShortcut(['Mod', 'Shift', 'F'], mac)).toBe('⇧⌘F');
      expect(formatShortcut(['Shift', 'Mod', 'B'], mac)).toBe('⇧⌘B');
      expect(formatShortcut(['Mod', 'Alt', 'Control', 'Shift', 'K'], mac)).toBe('⌃⌥⇧⌘K');
      expect(formatShortcut(['Command', 'Option', 'Ctrl', 'Shift', 'N'], mac)).toBe('⌃⌥⇧⌘N');
      expect(formatShortcut(['Meta', 'Control', 'Alt', 'R'], mac)).toBe('⌃⌥⌘R');
      expect(formatShortcut(['Mod', 'Cmd', 'f'], mac)).toBe('⌘F');
      expect(formatShortcut(['Mod', ','], mac)).toBe('⌘,');
    });

    it('maps macOS primary key glyphs cleanly', () => {
      expect(formatShortcut(['Enter'], mac)).toBe('↩');
      expect(formatShortcut(['Return'], mac)).toBe('↩');
      expect(formatShortcut(['Mod', 'Enter'], mac)).toBe('⌘↩');
      expect(formatShortcut(['Backspace'], mac)).toBe('⌫');
      expect(formatShortcut(['Option', 'Delete'], mac)).toBe('⌥⌫');
      expect(formatShortcut(['Escape'], mac)).toBe('⎋');
      expect(formatShortcut(['Esc'], mac)).toBe('⎋');
      expect(formatShortcut(['Shift', 'Tab'], mac)).toBe('⇧⇥');
      expect(formatShortcut(['Option', 'Space'], mac)).toBe('⌥␣');
      expect(formatShortcut(['Mod', ' '], mac)).toBe('⌘␣');
      expect(formatShortcut(['Control', 'ArrowUp'], mac)).toBe('⌃↑');
      expect(formatShortcut(['ArrowDown'], mac)).toBe('↓');
      expect(formatShortcut(['ArrowLeft'], mac)).toBe('←');
      expect(formatShortcut(['ArrowRight'], mac)).toBe('→');
    });

    it('keeps non-macOS Ctrl+Shift+F label formatting untouched', () => {
      expect(formatShortcut(['Mod', 'F'], win)).toBe('Ctrl+F');
      expect(formatShortcut(['Mod', 'Shift', 'F'], win)).toBe('Ctrl+Shift+F');
      expect(formatShortcut(['Control', 'Option', 'Shift', 'Enter'], win)).toBe('Ctrl+Alt+Shift+Enter');
      expect(formatShortcut(['Enter'], win)).toBe('Enter');
      expect(formatShortcut(['Escape'], linux)).toBe('Escape');
      expect(formatShortcut(['Mod', 'Shift', 'B'], linux)).toBe('Ctrl+Shift+B');
    });
  });

  it('detects IME composition from isComposing or keyCode 229', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });
});
