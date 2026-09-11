// Trylo Desktop — ModelSelector.
//
// A model picker chip in the InputBar's bottom action row.
// Lists the user's configured model plus the built-in free
// compute pool (grok via the local sub2api gateway), mirroring
// the opencode "your models + system models in one list" model.
//
// The user's OWN model (`configuredModel`, = settings.apiModel) is
// NEVER overwritten. Selecting a pool model only sets `poolModel`
// (settings.poolModel); the effective model for a run is
// poolModel || configuredModel, so switching pool↔own always
// round-trips and the user can always switch back.
//
// Interactions match ModePopover: click the chip to toggle, click
// outside or press Escape to close, Arrow keys + Enter to navigate.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

export type ModelChoice = { readonly id: string; readonly label: string; readonly hint: string };

/**
 * Built-in free-compute model pool. Keep in sync with the packaged CLI's built-in pool.
 */
const BUILTIN_MODELS: readonly ModelChoice[] = [
  { id: 'grok-4.5', label: 'Grok 4.5', hint: '内置免费算力池' },
];

/** Sentinel indicating "use your own configured model" in the listbox. */
const OWN_MODEL_ID = '__trylo_own__';

/** Human label for a model id (built-in names resolved, own names kept). */
export function labelForModel(model: string): string {
  if (!model) return '默认';
  const builtin = BUILTIN_MODELS.find((b) => b.id === model);
  if (builtin) return builtin.label;
  return model;
}

export interface ModelSelectorProps {
  /** The user's own configured model (settings.apiModel; '' = none). */
  readonly configuredModel: string;
  /** Active built-in pool override (settings.poolModel; '' = not on pool). */
  readonly poolModel: string;
  /** Switch back to the user's own configured model (clear poolModel). */
  readonly onSelectConfigured: () => void;
  /** Activate a built-in pool model (set poolModel). */
  readonly onSelectPool: (model: string) => void;
}

export function ModelSelector(props: ModelSelectorProps): ReactElement {
  const { configuredModel, poolModel, onSelectConfigured, onSelectPool } = props;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Always two entries: your own model + the pool. The current selection
  // is poolModel when set, otherwise your own model.
  const choices = useMemo<readonly ModelChoice[]>(() => {
    const own: ModelChoice = {
      id: OWN_MODEL_ID,
      label: configuredModel ? labelForModel(configuredModel) : '默认',
      hint: configuredModel ? '已配置模型' : '未配置，用 CLI 默认',
    };
    return [own, ...BUILTIN_MODELS];
  }, [configuredModel]);

  const currentId = poolModel.trim() ? poolModel : OWN_MODEL_ID;
  const currentIndex = Math.max(
    0,
    choices.findIndex((c) => c.id === currentId),
  );
  const [focusIndex, setFocusIndex] = useState(currentIndex);

  const onSelectRef = useRef<{ own: () => void; pool: (id: string) => void }>({
    own: onSelectConfigured,
    pool: onSelectPool,
  });
  const onCloseRef = useRef(() => setOpen(false));
  onSelectRef.current = { own: onSelectConfigured, pool: onSelectPool };
  onCloseRef.current = () => setOpen(false);

  const pick = (id: string): void => {
    if (id === OWN_MODEL_ID) onSelectRef.current.own();
    else onSelectRef.current.pool(id);
    onCloseRef.current();
  };

  useEffect(() => {
    if (!open) return;
    setFocusIndex(currentIndex);
  }, [open, currentIndex]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (anchorRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIndex((i) => (i + 1) % choices.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex((i) => (i - 1 + choices.length) % choices.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = choices[focusIndex];
        if (c) pick(c.id);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // choices are fresh per render; listeners are stable. `pick` closes the
    // popover, which re-truncates the guarded effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chipLabel = poolModel.trim()
    ? labelForModel(poolModel)
    : configuredModel
      ? labelForModel(configuredModel)
      : '默认';

  return (
    <div className="model-selector">
      <button
        ref={anchorRef}
        type="button"
        className="model-selector__chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${chipLabel}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-selector__chip-dot" aria-hidden="true" />
        <span className="model-selector__chip-label">{chipLabel}</span>
      </button>
      {open && (
        <ul
          ref={listRef}
          className="model-selector__popover mode-popover"
          role="listbox"
          aria-label="Select model"
          tabIndex={-1}
        >
          {choices.map((c, i) => {
            const active = i === focusIndex;
            const current = c.id === currentId;
            return (
              <li
                key={c.id}
                role="option"
                aria-selected={current}
                className={`mode-popover__item${active ? ' mode-popover__item--focus' : ''}${current ? ' mode-popover__item--current' : ''}`}
                onMouseEnter={() => setFocusIndex(i)}
                onClick={() => pick(c.id)}
              >
                <span className="mode-popover__label">{c.label}</span>
                <span className="mode-popover__hint">{c.hint}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}