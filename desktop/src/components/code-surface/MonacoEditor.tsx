// Trylo Desktop — MonacoEditor React wrapper.
//
// Day 3 fix: the editor is "controlled" — `props.value` is the source
// of truth. Day 4 fix: when the editor isn't ready yet (monaco init
// still in flight) and `props.value` changes, we cache the latest
// value in `pendingValueRef` and the mount effect flushes it once
// the editor instance is created. Day 5 add: `onDirtyChange` callback
// for the EditorBridge to consume. A programmatic-change guard
// prevents our own setValue() calls from flipping dirty=true.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type * as monaco from 'monaco-editor';
import { initMonaco } from '../../monaco-init';
import './MonacoEditor.css';

export interface MonacoEditorProps {
  /** Buffer content. The editor mirrors this; updates flow in when the
   *  prop changes. */
  readonly value: string;
  /** Initial language id (e.g. 'typescript', 'markdown'). */
  readonly language: string;
  /** Optional human-readable filename (shown in tab later). */
  readonly filename?: string;
  /** Fires when the dirty state flips. The editor doesn't keep the
   *  flag — it just emits transitions. Consumers (App.tsx) own the
   *  canonical state. */
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** Fires on every user-driven content change (Monaco's
   *  onDidChangeModelContent). Programmatic setValue() calls are
   *  filtered out via the internal guard. */
  readonly onUserChange?: (value: string) => void;
  /** Monaco theme id ('vs-dark' | 'vs'). When the value changes the
   *  editor calls `monaco.editor.setTheme()`. Defaults to 'vs-dark'. */
  readonly theme?: 'vs-dark' | 'vs';
}

export interface MonacoEditorRef {
  /** Get the current buffer content. */
  getValue: () => string;
  /** Force a dirty=true transition (e.g., for spike-time tests). */
  markDirty(): void;
  /** Get the underlying Monaco editor instance (or null if not yet
   *  initialized). The status bar uses this to subscribe to
   *  cursor-position changes. */
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null;
}

type Status = 'init' | 'ready' | 'error';

export const MonacoEditor = forwardRef<MonacoEditorRef, MonacoEditorProps>(
  (props, ref): ReactElement => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    /** Latest value of `props` reference. The onChange subscription
     *  is set once at mount time; without this ref it would capture
     *  the *initial* `props` (and the *initial* `onUserChange`),
     *  which closes over the *initial* `bridge` and so routes
     *  user-typed content to the wrong bridge after a tab switch.
     *  Reading the ref gives us the live closure every time the
     *  listener fires. */
    const propsRef = useRef(props);
    propsRef.current = props;
    /** Last value we pushed into the editor. Used to avoid the
     *  effect re-pushing its own write back into the editor. */
    const lastPushedRef = useRef<string | null>(null);
    /** Value that arrived while the editor was still initializing.
     *  The mount effect flushes this into the editor once it exists. */
    const pendingValueRef = useRef<string | null>(null);
    /** Last dirty state we reported to the parent. Used to avoid
     *  firing onDirtyChange(true) on every keystroke. */
    const lastDirtyRef = useRef<boolean>(false);
    /** Set true while WE call setValue() so the content-change
     *  listener doesn't interpret our own writes as user edits. */
    const programmaticChangeRef = useRef<boolean>(false);
    const [status, setStatus] = useState<Status>('init');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    useImperativeHandle(
      ref,
      () => ({
        getValue: () => editorRef.current?.getValue() ?? '',
        markDirty: () => {
          if (lastDirtyRef.current) return;
          lastDirtyRef.current = true;
          propsRef.current.onDirtyChange?.(true);
        },
        getEditor: () => editorRef.current,
      }),
      [],
    );

    // Mount the editor once. The initial value is whatever props.value
    // happens to be at mount time (usually "" before the file loads);
    // the next effect catches up once the value arrives.
    useEffect(() => {
      let cancelled = false;

      initMonaco()
        .then(async () => {
          if (cancelled) return;
          const monacoNs = await import('monaco-editor');
          if (cancelled || !containerRef.current) return;

          // If a newer value arrived while we were initializing, use
          // that one. The controlled sync effect can't reach us while
          // editorRef.current is null; this is the catch-up path.
          const initialValue =
            pendingValueRef.current !== null
              ? pendingValueRef.current
              : props.value;

          const editor = monacoNs.editor.create(containerRef.current, {
            value: initialValue,
            language: props.language,
            theme: props.theme ?? 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            renderWhitespace: 'selection',
            scrollBeyondLastLine: false,
          });

          editorRef.current = editor;
          lastPushedRef.current = initialValue;
          pendingValueRef.current = null;
          setStatus('ready');

          // Day 5: wire dirty tracking. The programmatic-change guard
          // ensures our own setValue() calls (above + future
          // controlled-sync) don't trip dirty=true.
          //
          // B: also forward every user change to props.onUserChange
          // so the bridge's buffer stays in sync. Programmatic
          // changes are filtered out by the same guard. Use
          // `propsRef.current` so the live (latest) closure is
          // invoked — otherwise we'd capture the mount-time
          // `onUserChange` and route every typing back to the
          // bridge that was active at mount (i.e. before any
          // tab switch), so the user's input would go to the
          // wrong file.
          //
          // We also update `lastPushedRef` from the user-driven
          // change so the controlled-sync effect on the next
          // render sees the same value and skips its setValue
          // call. Without this, every keystroke would round-trip
          // through the React state machine, the editor's value
          // would be re-pushed, the cursor would jump to (0,0)
          // and the user's caret would die.
          const onChange = editor.onDidChangeModelContent(() => {
            if (programmaticChangeRef.current) return;
            const value = editor.getValue();
            lastPushedRef.current = value;
            if (!lastDirtyRef.current) {
              lastDirtyRef.current = true;
              propsRef.current.onDirtyChange?.(true);
            }
            propsRef.current.onUserChange?.(value);
          });
          // Stash the subscription on the editor for cleanup; we
          // dispose on unmount via editor.dispose() which clears
          // every subscription attached to the model.
          void onChange;
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setStatus('error');
          setErrorMsg(err instanceof Error ? err.message : String(err));
        });

      return () => {
        cancelled = true;
        editorRef.current?.dispose();
        editorRef.current = null;
        lastPushedRef.current = null;
        pendingValueRef.current = null;
        lastDirtyRef.current = false;
        programmaticChangeRef.current = false;
      };
      // Mount-only: re-creating the editor on prop changes would wipe
      // the undo stack and the cursor position. The next effect handles
      // value sync.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Controlled-value sync. Two paths:
    //   1. Editor is ready → push immediately (if value differs from
    //      what we last pushed, to avoid feedback loops). Suppress
    //      the dirty transition that the content-change listener
    //      would otherwise emit.
    //   2. Editor is not ready yet → cache in pendingValueRef; the
    //      mount effect picks it up when initMonaco resolves.
    useEffect(() => {
      if (editorRef.current) {
        if (lastPushedRef.current === props.value) return;
        programmaticChangeRef.current = true;
        try {
          editorRef.current.setValue(props.value);
        } finally {
          programmaticChangeRef.current = false;
        }
        lastPushedRef.current = props.value;
      } else {
        pendingValueRef.current = props.value;
      }
    }, [props.value]);

    // Theme sync. Phase 1 #9 (Theming): when the parent passes a
    // different Monaco theme id, call setTheme on the running
    // editor. We rely on propsRef so this effect closes over
    // the live closure (vs the stale mount-time one). No-op when
    // the value is undefined.
    useEffect(() => {
      const theme = propsRef.current.theme;
      const editor = editorRef.current;
      if (!editor || !theme) return;
      void import('monaco-editor').then((m) => m.editor.setTheme(theme));
    }, [propsRef.current.theme]);

    return (
      <div className="monaco-editor-wrap">
        {status !== 'ready' && (
          <div className="monaco-editor-status">
            {status === 'init' && 'Initializing Monaco…'}
            {status === 'error' && (
              <>
                <strong>Monaco init failed.</strong>
                <pre>{errorMsg ?? 'unknown error'}</pre>
              </>
            )}
          </div>
        )}
        <div
          ref={containerRef}
          className="monaco-editor-container"
          data-filename={props.filename ?? 'untitled'}
        />
      </div>
    );
  },
);

MonacoEditor.displayName = 'MonacoEditor';
