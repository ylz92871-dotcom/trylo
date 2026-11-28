import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type ReactElement,
  type RefObject,
} from 'react';
import { FileText, Slash } from 'lucide-react';
import { isImeComposing } from '../../utils/platform';
import { listWorkspaceFiles, type WorkspaceFileEntry } from '../command-palette/workspace-file-index';
import type { CaretCoords, CaretTrigger } from './caret-position';

export interface SlashSuggestion {
  readonly id: string;
  readonly command: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly insertText?: string;
  readonly run?: () => void;
}

export interface CaretSuggestionsProps {
  readonly trigger: CaretTrigger | null;
  readonly coords: CaretCoords | null;
  readonly textareaRef: RefObject<HTMLTextAreaElement>;
  readonly workspace?: string;
  readonly slashCommands: readonly SlashSuggestion[];
  readonly keyHandlerRef: MutableRefObject<((event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean) | null>;
  readonly onInsertFile: (relativePath: string, trigger: CaretTrigger) => void;
  readonly onSelectSlash: (item: SlashSuggestion, trigger: CaretTrigger) => void;
  readonly onDismiss: () => void;
}

interface SuggestionItem {
  readonly id: string;
  readonly kind: 'file' | 'slash';
  readonly label: string;
  readonly detail?: string;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly filePath?: string;
  readonly slash?: SlashSuggestion;
}

export function CaretSuggestions(props: CaretSuggestionsProps): ReactElement | null {
  const {
    trigger,
    coords,
    textareaRef,
    workspace,
    slashCommands,
    keyHandlerRef,
    onInsertFile,
    onSelectSlash,
    onDismiss,
  } = props;

  const [files, setFiles] = useState<readonly WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const [leftOffset, setLeftOffset] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const reqSeqRef = useRef(0);

  const triggerKind = trigger?.trigger ?? null;
  useEffect(() => {
    if (triggerKind !== '@' || !workspace) {
      setLoading(false);
      return undefined;
    }

    const seq = ++reqSeqRef.current;
    const controller = new AbortController();
    setLoading(true);

    listWorkspaceFiles(workspace, { signal: controller.signal })
      .then((loaded) => {
        if (seq !== reqSeqRef.current || controller.signal.aborted) return;
        setFiles(loaded);
        setLoading(false);
      })
      .catch(() => {
        if (seq !== reqSeqRef.current || controller.signal.aborted) return;
        setFiles([]);
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [triggerKind, workspace]);

  const items = useMemo<readonly SuggestionItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query.trim().toLowerCase();

    if (trigger.trigger === '/') {
      return slashCommands
        .filter((cmd) => {
          if (!q) return true;
          return `${cmd.command} ${cmd.label} ${cmd.description}`.toLowerCase().includes(q);
        })
        .map((cmd) => ({
          id: `slash:${cmd.id}`,
          kind: 'slash' as const,
          label: cmd.command,
          detail: cmd.enabled ? cmd.description : cmd.reason ?? cmd.description,
          enabled: cmd.enabled,
          reason: cmd.reason,
          slash: cmd,
        }));
    }

    return files
      .filter((file) => {
        if (!q) return true;
        return file.relativePath.toLowerCase().includes(q) || file.name.toLowerCase().includes(q);
      })
      .slice(0, 12)
      .map((file) => ({
        id: `file:${file.path}`,
        kind: 'file' as const,
        label: file.name,
        detail: file.relativePath,
        enabled: true,
        filePath: file.relativePath,
      }));
  }, [trigger, slashCommands, files]);

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.trigger, trigger?.query]);

  useEffect(() => {
    if (items.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((idx) => Math.min(idx, items.length - 1));
  }, [items.length]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const popup = listRef.current;
    if (!trigger || !textarea || !popup) return;

    const rect = textarea.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    setPlacement(spaceBelow > 220 && spaceAbove < 220 ? 'below' : 'above');

    const maxLeft = Math.max(0, textarea.clientWidth - 260);
    const rawLeft = coords?.left ?? 0;
    setLeftOffset(Math.max(0, Math.min(maxLeft, rawLeft)));
  }, [trigger, coords, textareaRef, items.length]);

  useEffect(() => {
    if (!trigger) {
      keyHandlerRef.current = null;
      return;
    }

    keyHandlerRef.current = (event) => {
      if (isImeComposing(event)) return false;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return true;
      }

      if (items.length === 0) return false;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const current = items[activeIndex];
        if (!current || !current.enabled) return false;
        event.preventDefault();
        if (current.kind === 'file' && current.filePath) {
          onInsertFile(current.filePath, trigger);
        } else if (current.kind === 'slash' && current.slash) {
          onSelectSlash(current.slash, trigger);
        }
        return true;
      }
      return false;
    };

    return () => {
      keyHandlerRef.current = null;
    };
  }, [trigger, items, activeIndex, keyHandlerRef, onDismiss, onInsertFile, onSelectSlash]);

  if (!trigger) return null;

  const anchorStyle = coords
    ? placement === 'above'
      ? { left: `${leftOffset}px`, bottom: `calc(100% - ${Math.max(0, coords.top)}px + 6px)` }
      : { left: `${leftOffset}px`, top: `${Math.max(0, coords.top + coords.lineHeight + 6)}px` }
    : { left: '0px', bottom: 'calc(100% + 6px)' };

  return (
    <div
      ref={listRef}
      className="caret-suggestions"
      role="listbox"
      aria-label={trigger.trigger === '@' ? '引用工作区文件' : '快捷斜杠指令'}
      data-placement={placement}
      style={anchorStyle}
    >
      {items.length === 0 ? (
        <div className="caret-suggestions__empty">
          {loading ? '正在检索文件…' : trigger.trigger === '@' ? '没有匹配的工作区文件' : '没有匹配的指令'}
        </div>
      ) : (
        items.map((item, idx) => {
          const active = idx === activeIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={active}
              aria-disabled={!item.enabled}
              className={`caret-suggestions__item${active ? ' caret-suggestions__item--active' : ''}${!item.enabled ? ' caret-suggestions__item--disabled' : ''}`}
              onMouseDown={(event) => {
                // Keep textarea focus intact while picking an item.
                event.preventDefault();
              }}
              onMouseMove={() => setActiveIndex(idx)}
              onClick={() => {
                if (!item.enabled) return;
                if (item.kind === 'file' && item.filePath) {
                  onInsertFile(item.filePath, trigger);
                } else if (item.kind === 'slash' && item.slash) {
                  onSelectSlash(item.slash, trigger);
                }
              }}
            >
              <span className="caret-suggestions__icon" aria-hidden="true">
                {item.kind === 'file' ? <FileText size={13} /> : <Slash size={13} />}
              </span>
              <span className="caret-suggestions__text">
                <span className="caret-suggestions__label">{item.label}</span>
                {item.detail && <span className="caret-suggestions__detail">{item.detail}</span>}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
