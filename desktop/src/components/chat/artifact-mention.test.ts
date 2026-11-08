import { describe, expect, it } from 'vitest';
import { joinRoot, resolveMentionPath, toolPathsOf } from './artifact-mention';

const ROOT = 'D:/CC/trylo';

describe('artifact-mention (Round-3 P2: same-name files must not 404)', () => {
  it('resolves a clean relative path verbatim', () => {
    expect(resolveMentionPath(ROOT, 'docs/report.md', [])).toBe(`${ROOT}/docs/report.md`);
  });

  it('resolves a bare basename against the newest same-name tool path', () => {
    const paths = toolPathsOf([
      { kind: 'tool', input: { file_path: 'docs/report.md' } },
      { kind: 'tool', input: { file_path: 'slides/report.md' } },
    ]);
    // Newest first: the later touch wins.
    expect(resolveMentionPath(ROOT, 'report.md', paths)).toBe(`${ROOT}/slides/report.md`);
  });

  it('falls back to root/basename when nothing in the conversation matches', () => {
    expect(resolveMentionPath(ROOT, 'report.md', ['other/file.txt'])).toBe(
      `${ROOT}/report.md`,
    );
  });

  it('never guesses a mention that already carries a directory', () => {
    const paths = toolPathsOf([{ kind: 'tool', input: { file_path: 'slides/report.md' } }]);
    expect(resolveMentionPath(ROOT, 'docs/report.md', paths)).toBe(`${ROOT}/docs/report.md`);
  });

  it('normalizes backslashes and surrounding quotes', () => {
    expect(resolveMentionPath(ROOT, '"docs\\report.md"', [])).toBe(`${ROOT}/docs/report.md`);
  });

  it('rejects absolute and traversal mentions', () => {
    expect(resolveMentionPath(ROOT, '/etc/passwd', [])).toBeNull();
    expect(resolveMentionPath(ROOT, '../secrets.md', [])).toBeNull();
    expect(resolveMentionPath(ROOT, 'C:/x/y.md', [])).toBeNull();
  });

  it('accepts absolute tool paths only under the workspace root', () => {
    expect(
      resolveMentionPath(ROOT, 'report.md', ['D:/CC/trylo/slides/report.md']),
    ).toBe('D:/CC/trylo/slides/report.md');
    expect(resolveMentionPath(ROOT, 'report.md', ['D:/other/report.md'])).toBe(
      `${ROOT}/report.md`,
    );
  });

  it('joinRoot keeps the old join semantics', () => {
    expect(joinRoot(ROOT, 'a/b.md')).toBe(`${ROOT}/a/b.md`);
    expect(joinRoot(ROOT, 'a\\b.md')).toBe(`${ROOT}/a/b.md`);
    expect(joinRoot(ROOT, '../x')).toBeNull();
  });
});
