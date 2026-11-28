import type * as Monaco from 'monaco-editor';
const registered = new WeakSet<object>();
export const editorTheme = (theme: 'light' | 'dark'): string => `trylo-${theme}`;

/** One presentation policy; model ownership stays with each editor/reader. */
export const editorReadingOptions: Monaco.editor.IEditorOptions = {
  fontFamily: '"SF Mono", ui-monospace, "SFMono-Regular", Menlo, "Cascadia Code", Consolas, monospace',
  fontSize: 13, lineHeight: 22, fontLigatures: false,
  lineNumbers: 'on', lineNumbersMinChars: 3, lineDecorationsWidth: 12,
  minimap: { enabled: false }, padding: { top: 12, bottom: 12 },
  scrollBeyondLastLine: false, renderWhitespace: 'selection',
  renderLineHighlight: 'none', overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true, smoothScrolling: true,
  stickyScroll: { enabled: false },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
};

export function registerEditorAppearance(api: typeof Monaco): void {
  if (registered.has(api)) return;
  for (const dark of [false, true]) {
    api.editor.defineTheme(editorTheme(dark ? 'dark' : 'light'), {
      base: dark ? 'vs-dark' : 'vs', inherit: true,
      rules: [
        { token: 'comment', foreground: dark ? '7D7B74' : '7A7872' },
        { token: 'keyword', foreground: dark ? 'C2A8E3' : '7D4FA0' },
        { token: 'string', foreground: dark ? '9BC79D' : '2E7347' },
        { token: 'number', foreground: dark ? 'DEB87E' : '966816' },
        { token: 'type.identifier', foreground: dark ? '8BB7E8' : '235D90' },
      ],
      colors: {
        'editor.background': dark ? '#171715' : '#ffffff',
        'editor.foreground': dark ? '#e6e3dc' : '#191918',
        'editorGutter.background': dark ? '#171715' : '#ffffff',
        'editorLineNumber.foreground': dark ? '#5e5d58' : '#9a9890',
        'editorLineNumber.activeForeground': dark ? '#c8c5bd' : '#474642',
        'editor.lineHighlightBackground': dark ? '#20201d' : '#f5f3ec',
        'editor.selectionBackground': dark ? '#2b3f5980' : '#dce8f6',
        'editor.inactiveSelectionBackground': dark ? '#292c3270' : '#ebeae4',
        'editorIndentGuide.background1': dark ? '#262623' : '#ece9e2',
        'editorWidget.background': dark ? '#222220' : '#ffffff',
        'editorWidget.border': dark ? '#3c3b37' : '#d3cfc4',
        'editorWidget.resizeBorder': dark ? '#dec176' : '#966816',
        'editor.findMatchBackground': dark ? '#8a6f3388' : '#f0d89a',
        'editor.findMatchHighlightBackground': dark ? '#8a6f3344' : '#f5ecd7',
        'focusBorder': dark ? '#7eaeeb' : '#235d90',
        'diffEditor.insertedTextBackground': dark ? '#3f8f6345' : '#23784c24',
        'diffEditor.removedTextBackground': dark ? '#b85c6345' : '#bc3e4424',
        'diffEditor.insertedLineBackground': dark ? '#1b2d2280' : '#e9f5ee',
        'diffEditor.removedLineBackground': dark ? '#351f2280' : '#fceeef',
        'diffEditor.diagonalFill': dark ? '#2c2c29' : '#e4e1d9',
        'diffEditor.border': dark ? '#2a2a27' : '#e4e1d9',
        'diffEditorGutter.insertedLineBackground': dark ? '#26423070' : '#d8eedf',
        'diffEditorGutter.removedLineBackground': dark ? '#4d2b3070' : '#f7dcdf',
        'scrollbarSlider.background': dark ? '#6c6a6350' : '#9a989050',
        'scrollbarSlider.hoverBackground': dark ? '#8a888080' : '#7a787280',
      },
    });
  }
  registered.add(api);
}
