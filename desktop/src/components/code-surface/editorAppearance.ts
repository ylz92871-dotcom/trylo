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
        { token: 'comment', foreground: dark ? '7F8995' : '7B8491' },
        { token: 'keyword', foreground: dark ? 'B8A4DC' : '8254A4' },
        { token: 'string', foreground: dark ? 'A3C29E' : '47774A' },
        { token: 'number', foreground: dark ? 'D7B88D' : '986337' },
        { token: 'type.identifier', foreground: dark ? '8FBBD3' : '316C86' },
      ],
      colors: {
        'editor.background': dark ? '#1c1d20' : '#ffffff',
        'editor.foreground': dark ? '#d5d8df' : '#343941',
        'editorGutter.background': dark ? '#1c1d20' : '#ffffff',
        'editorLineNumber.foreground': dark ? '#626973' : '#9aa1ab',
        'editorLineNumber.activeForeground': dark ? '#bbc2cc' : '#4a5665',
        'editor.lineHighlightBackground': dark ? '#25272b' : '#f5f6f8',
        'editor.selectionBackground': dark ? '#3d526d80' : '#d9e6f5',
        'editor.inactiveSelectionBackground': dark ? '#333c4c70' : '#e9edf3',
        'editorIndentGuide.background1': dark ? '#2c2f35' : '#eef0f3',
        'editorWidget.background': dark ? '#24262b' : '#ffffff',
        'editorWidget.border': dark ? '#3b3e45' : '#dce1e7',
        'editorWidget.resizeBorder': dark ? '#5b6370' : '#8b96a6',
        'editor.findMatchBackground': dark ? '#866b3b90' : '#f3dfad',
        'editor.findMatchHighlightBackground': dark ? '#866b3b45' : '#f7edce',
        'focusBorder': dark ? '#68798e' : '#7b91ac',
        'diffEditor.insertedTextBackground': dark ? '#41996b45' : '#2c8b4c26',
        'diffEditor.removedTextBackground': dark ? '#b75f6845' : '#c6525b26',
        'diffEditor.insertedLineBackground': dark ? '#294b353d' : '#edf7f0',
        'diffEditor.removedLineBackground': dark ? '#542e363d' : '#fcf0f1',
        'diffEditor.diagonalFill': dark ? '#353940' : '#e2e6eb',
        'diffEditor.border': dark ? '#34373d' : '#e3e6eb',
        'diffEditorGutter.insertedLineBackground': dark ? '#34574065' : '#e2f0e7',
        'diffEditorGutter.removedLineBackground': dark ? '#61394165' : '#f6e3e6',
        'scrollbarSlider.background': dark ? '#66707c50' : '#9aa5b450',
        'scrollbarSlider.hoverBackground': dark ? '#7c879580' : '#8b98a980',
      },
    });
  }
  registered.add(api);
}
