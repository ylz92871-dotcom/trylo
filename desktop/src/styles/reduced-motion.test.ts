// Trylo Desktop — reduced-motion CSS fallback regression test.
//
// Spec §7.5: under `prefers-reduced-motion: reduce`, every
// infinite animation must resolve to `none`. Zeroing the
// --duration-* tokens is NOT enough — hardcoded loop
// animations (which never read the tokens) must be disabled
// by selector. This is the unified motion layer in
// tokens.css plus local fallbacks in the component sheets.
//
// jsdom does not load the app stylesheets, so this test is
// source-level: it parses every stylesheet under src/styles,
// finds every rule that declares an infinite animation, and
// asserts that each such selector is covered by an
// `animation: none` rule inside a `prefers-reduced-motion:
// reduce` block. A new loop animation added without a
// fallback fails the build.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Vitest runs from the desktop package root (npm test), so the
// stylesheets live at src/styles relative to the working dir.
const STYLES_DIR = resolve(process.cwd(), 'src/styles');

interface Rule {
  header: string;
  body: string;
}

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...cssFiles(path));
    else if (entry.endsWith('.css')) out.push(path);
  }
  return out;
}

/** Split CSS into brace-delimited rules (handles nested @media). */
function parseRules(css: string): Rule[] {
  // Drop comments first — they sit between `}` and `{`, which would
  // otherwise get concatenated into rule headers and break both
  // @media detection and selector extraction.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf('{', i);
    if (open === -1) break;
    let selStart = open;
    while (selStart > 0 && clean[selStart - 1] !== '}') selStart -= 1;
    let depth = 1;
    let j = open + 1;
    for (; j < clean.length && depth > 0; j += 1) {
      if (clean[j] === '{') depth += 1;
      else if (clean[j] === '}') depth -= 1;
    }
    rules.push({
      header: clean.slice(selStart, open).trim(),
      body: clean.slice(open + 1, j - 1),
    });
    i = j;
  }
  return rules;
}

/** Visit every plain rule, recursing into @media blocks. */
function walkRules(css: string, visit: (rule: Rule) => void): void {
  for (const rule of parseRules(css)) {
    if (rule.header.startsWith('@media')) walkRules(rule.body, visit);
    else visit(rule);
  }
}

/** Split a (possibly comma-grouped) selector list into individual selectors. */
function splitSelectors(selector: string): string[] {
  return selector
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const REDUCE_MEDIA = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/;
const ANIM_NONE = /animation\s*:\s*none/i;
const ANIM_INFINITE = /animation\s*:\s*[^;]*infinite/i;

describe('reduced-motion CSS fallback (spec §7.5)', () => {
  // Collected across every stylesheet under src/styles.
  const infiniteSelectors: string[] = [];
  const reducedSelectors = new Set<string>();

  for (const file of cssFiles(STYLES_DIR)) {
    const css = readFileSync(file, 'utf8');
    walkRules(css, (rule) => {
      if (ANIM_NONE.test(rule.body)) {
        for (const sel of splitSelectors(rule.header)) reducedSelectors.add(sel);
      }
      if (ANIM_INFINITE.test(rule.body)) {
        for (const sel of splitSelectors(rule.header)) infiniteSelectors.push(sel);
      }
    });
  }

  it('scans the expected stylesheet set', () => {
    expect(cssFiles(STYLES_DIR).length).toBeGreaterThan(5);
  });

  it('zeroes the motion duration tokens under reduce', () => {
    const tokens = readFileSync(join(STYLES_DIR, 'tokens.css'), 'utf8');
    const media = parseRules(tokens).find((r) => REDUCE_MEDIA.test(r.header));
    expect(media).toBeDefined();
    for (const prop of [
      '--duration-fast: 0ms',
      '--duration-base: 0ms',
      '--duration-slow: 0ms',
    ]) {
      expect(media!.body).toContain(prop);
    }
  });

  it('every infinite animation has a `prefers-reduced-motion` fallback', () => {
    const uncovered = infiniteSelectors.filter((sel) => !reducedSelectors.has(sel));
    expect(uncovered).toEqual([]);
  });

  it('covers every §7.2 primary loop animation', () => {
    for (const sel of [
      '.turn-progress__logo--spin',
      '.streaming-indicator__dot',
      '.process-header__dot--pulse',
      '.tool__status-icon--spin',
      '.empty-state__logo',
      '.empty-state__logo > *',
    ]) {
      expect(reducedSelectors).toContain(sel);
    }
  });
});
