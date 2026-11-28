export interface NavigatorLike {
  readonly platform?: string;
  readonly userAgent?: string;
}

function readNavigator(nav?: NavigatorLike): NavigatorLike | undefined {
  if (nav !== undefined) return nav;
  return typeof navigator !== 'undefined' ? navigator : undefined;
}

/**
 * Detect macOS while avoiding false positives in jsdom on macOS hosts where
 * `navigator.platform` is empty and `userAgent` only contains `darwin`.
 */
export function isMacPlatform(nav?: NavigatorLike): boolean {
  const target = readNavigator(nav);
  if (!target) return false;

  const platform = target.platform ?? '';
  const userAgent = target.userAgent ?? '';
  return /mac/i.test(platform) || /macintosh|mac os x/i.test(userAgent);
}

export function isWindowsPlatform(nav?: NavigatorLike): boolean {
  const target = readNavigator(nav);
  if (!target) return false;

  const platform = target.platform ?? '';
  const userAgent = target.userAgent ?? '';
  return /win/i.test(platform) || /windows/i.test(userAgent);
}

export function isPrimaryModKey(event: { readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

const MAC_MODIFIER_ORDER: Readonly<Record<string, { readonly rank: number; readonly glyph: string }>> = {
  control: { rank: 0, glyph: '⌃' },
  ctrl: { rank: 0, glyph: '⌃' },
  alt: { rank: 1, glyph: '⌥' },
  option: { rank: 1, glyph: '⌥' },
  shift: { rank: 2, glyph: '⇧' },
  mod: { rank: 3, glyph: '⌘' },
  meta: { rank: 3, glyph: '⌘' },
  cmd: { rank: 3, glyph: '⌘' },
  command: { rank: 3, glyph: '⌘' },
};

const MAC_KEY_GLYPHS: Readonly<Record<string, string>> = {
  enter: '↩',
  return: '↩',
  backspace: '⌫',
  delete: '⌫',
  escape: '⎋',
  esc: '⎋',
  tab: '⇥',
  space: '␣',
  ' ': '␣',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

const NON_MAC_MODIFIER_LABELS: Readonly<Record<string, string>> = {
  mod: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

function formatMacPrimaryKey(key: string): string {
  const glyph = MAC_KEY_GLYPHS[key.toLowerCase()];
  if (glyph !== undefined) return glyph;
  if (key.length === 1 && key >= 'a' && key <= 'z') return key.toUpperCase();
  return key;
}

/**
 * Format a key chord for display.
 * On macOS, modifier glyphs follow Apple HIG order (`⌃⌥⇧⌘`) with no separator,
 * followed by mapped primary key glyphs (`↩`, `⌫`, `⎋`, `⇥`, `␣`, `↑↓←→`).
 */
export function formatShortcut(keys: readonly string[], nav?: NavigatorLike): string {
  const mac = isMacPlatform(nav);
  if (!mac) {
    return keys
      .map((key) => NON_MAC_MODIFIER_LABELS[key.toLowerCase()] ?? key)
      .join('+');
  }

  const modifiers = new Map<number, string>();
  const primaryKeys: string[] = [];

  for (const key of keys) {
    const mod = MAC_MODIFIER_ORDER[key.toLowerCase()];
    if (mod !== undefined) {
      modifiers.set(mod.rank, mod.glyph);
    } else {
      primaryKeys.push(formatMacPrimaryKey(key));
    }
  }

  const sortedModifiers = Array.from(modifiers.entries())
    .sort(([a], [b]) => a - b)
    .map(([, glyph]) => glyph);

  return `${sortedModifiers.join('')}${primaryKeys.join('')}`;
}

export function isImeComposing(event: {
  readonly nativeEvent?: { readonly isComposing?: boolean; readonly keyCode?: number };
}): boolean {
  return event.nativeEvent?.isComposing === true || event.nativeEvent?.keyCode === 229;
}
