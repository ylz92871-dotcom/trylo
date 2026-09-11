// Trylo Desktop — hidden-dirs unit tests. See
// v1.15-handoff §2.4 ("hide node_modules, .git, dist, etc.").

import { describe, expect, it } from 'vitest';
import { HIDDEN_DIRS, isHiddenName } from './hidden-dirs';

describe('isHiddenName', () => {
  it('hides every name starting with a dot', () => {
    expect(isHiddenName('.git')).toBe(true);
    expect(isHiddenName('.trylo')).toBe(true);
    expect(isHiddenName('.env')).toBe(true);
    expect(isHiddenName('.something-long')).toBe(true);
  });

  it('hides the well-known heavy folders from the spec', () => {
    expect(isHiddenName('node_modules')).toBe(true);
    expect(isHiddenName('dist')).toBe(true);
    expect(isHiddenName('target')).toBe(true);
    expect(isHiddenName('build')).toBe(true);
    expect(isHiddenName('out')).toBe(true);
  });

  it('does not hide normal source files or folders', () => {
    expect(isHiddenName('src')).toBe(false);
    expect(isHiddenName('App.tsx')).toBe(false);
    expect(isHiddenName('package.json')).toBe(false);
    expect(isHiddenName('README.md')).toBe(false);
  });

  it('HIDDEN_DIRS set is non-empty and stable', () => {
    expect(HIDDEN_DIRS.size).toBeGreaterThan(0);
    expect(HIDDEN_DIRS.has('node_modules')).toBe(true);
    expect(HIDDEN_DIRS.has('.git')).toBe(true);
  });
});
