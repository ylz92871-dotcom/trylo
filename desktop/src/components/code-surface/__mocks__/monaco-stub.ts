// Lightweight API boundary for shell/focus tests. Browser QA uses real Monaco.
export const languages = { register: () => {}, setMonarchTokensProvider: () => {} };
export const editor = {
  defineTheme: () => {}, setTheme: () => {},
  createModel: (initial = '') => {
    let value = initial;
    return { dispose: () => {}, getValue: () => value, setValue: (next: string) => { value = next; }, getLineCount: () => value.split('\n').length };
  },
  createDiffEditor: () => {
    let model: { original: ReturnType<typeof editor.createModel>; modified: ReturnType<typeof editor.createModel> } | undefined;
    let update = () => {};
    return { setModel: (next: typeof model) => { model = next; update(); }, getModel: () => model,
      updateOptions: () => {}, onDidUpdateDiff: (listener: () => void) => { update = listener; }, getLineChanges: () => [],
      getModifiedEditor: () => ({ focus: () => {}, getAction: () => ({ run: () => {} }), getModel: () => model?.modified, setPosition: () => {}, revealLineInCenter: () => {} }),
      dispose: () => {},
    };
  },
};
