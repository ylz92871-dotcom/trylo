// Trylo Desktop — minimal monaco-editor stub for the test runner.
// The real monaco-editor is ~50MB and not relevant to the
// keyboard / ARIA / focus-return tests that import
// GitDiffView. The component tolerates a no-op monaco surface —
// the dynamic import resolves to this file in the test env and
// the `.git-diff-view__monaco` container stays empty, which is
// exactly what GitDiffView.test.tsx asserts on.

export const editor = {
  createModel: () => ({ dispose: () => {} }),
  createDiffEditor: () => ({ setModel: () => {}, dispose: () => {} }),
};
