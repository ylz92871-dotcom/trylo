import { Check, ChevronDown } from 'lucide-react';
// Trylo Desktop — ModelSelector.
//
// A model picker chip in the InputBar's bottom action row.
// Lists saved connections and account-authorized text models. The free pool
// is discovered by the Service Host; no provider credential lives in this UI.
//
// The user's OWN model (`configuredModel`, = settings.apiModel) is
// NEVER overwritten. Selecting a pool model only sets `poolModel`
// (settings.poolModel); the effective model for a run is
// poolModel || configuredModel, so switching pool↔own always
// round-trips and the user can always switch back.
//
// The popover renders through a portal with the same anchored
// placement as ModePopover (flips above/below the chip so it is
// never clipped by the viewport top). Rows are grouped under
// "我的配置" / "免费算力池" headings; keyboard navigation walks the
// flat option order, which the grouping preserves.
//
// Interactions: click the chip to toggle, click outside or press
// Escape to close, Arrow keys + Enter to navigate.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { usePlatformModels } from '../../account/use-platform-models';

export type ModelChoice = { readonly id: string; readonly label: string; readonly hint: string };

/** Sentinel indicating "use your own configured model" in the listbox. */
const OWN_MODEL_ID = '__trylo_own__';

/** Prefix distinguishing saved profiles (cfg- ids) from builtin pool ids. */
const PROFILE_PREFIX = 'profile:';

/** Which group a row belongs to; drives the section headings. */
type ModelGroup = 'mine' | 'pool';

/** Group order in the listbox. The flat option list is built in this order. */
const GROUPS: readonly { readonly key: ModelGroup; readonly title: string }[] = [
  { key: 'mine', title: '我的配置' },
  { key: 'pool', title: '免费算力池' },
];

/** Preserve the exact server model ID. */
export function labelForModel(model: string): string {
  return model || '默认';
}

export interface ModelSelectorProps {
  /** The user's own configured model (settings.apiModel; '' = none). */
  readonly configuredModel: string;
  /** Active built-in pool override (settings.poolModel; '' = not on pool). */
  readonly poolModel: string;
  /** Saved connection profiles (settings.modelProfiles) as listbox options;
   *  each carries the profile id in `id`. */
  readonly savedProfiles?: readonly ModelChoice[];
  /** The active profile id (settings.activeModelProfileId; '' = none). */
  readonly activeProfileId?: string;
  /** Switch back to the user's own configured model (clear poolModel). */
  readonly onSelectConfigured: () => void;
  /** Activate a built-in pool model (set poolModel). */
  readonly onSelectPool: (model: string) => void;
  /** Load a saved profile into the active connection. */
  readonly onSelectProfile?: (id: string) => void;
}

export function ModelSelector(props: ModelSelectorProps): ReactElement {
  const {
    configuredModel,
    poolModel,
    savedProfiles = [],
    activeProfileId = '',
    onSelectConfigured,
    onSelectPool,
    onSelectProfile,
  } = props;
  const [open, setOpen] = useState(false);
  const platform = usePlatformModels(open);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<'keyboard' | 'pointer'>('keyboard');

  const activeProfile = savedProfiles.find((p) => p.id === activeProfileId);

  // Flat option list: your own model, then saved profiles, then the
  // builtin pool. Keyboard focus indexes into THIS array; the render
  // groups rows under headings without reordering them.
  const choices = useMemo<readonly (ModelChoice & { readonly group: ModelGroup })[]>(() => {
    const own: ModelChoice & { readonly group: ModelGroup } = {
      id: OWN_MODEL_ID,
      label: configuredModel ? labelForModel(configuredModel) : '默认模型',
      hint: activeProfile
        ? `已配置模型 · ${activeProfile.label}`
        : configuredModel
          ? '已配置模型'
          : '未配置，用 CLI 默认',
      group: 'mine',
    };
    const profiles = savedProfiles.map(
      (p): ModelChoice & { readonly group: ModelGroup } => ({
        id: `${PROFILE_PREFIX}${p.id}`,
        label: p.label,
        hint: p.hint,
        group: 'mine',
      }),
    );
    const pool = platform.models.map(model => ({ id: model.id, label: model.id, hint: model.remaining > 0 ? 'Trylo 免费池' : '今日额度已用完' })).map(
      (b): ModelChoice & { readonly group: ModelGroup } => ({ ...b, group: 'pool' }),
    );
    return [own, ...profiles, ...pool];
  }, [configuredModel, savedProfiles, activeProfile, platform.models]);

  const currentPoolId = poolModel.trim();
  const currentId = currentPoolId
    ? currentPoolId
    : activeProfile
      ? `${PROFILE_PREFIX}${activeProfile.id}`
      : OWN_MODEL_ID;
  const currentIndex = Math.max(
    0,
    choices.findIndex((c) => c.id === currentId),
  );
  const [focusIndex, setFocusIndex] = useState(currentIndex);
  useEffect(() => { setFocusIndex(index => Math.min(index, choices.length - 1)); }, [choices.length]);

  // Fresh-value mirrors. The document-level keydown listener is bound
  // once per open (deps [open]); without these it would close over the
  // focusIndex/choices of the render that opened the popover — arrow
  // keys moved the highlight while Enter re-picked the row that was
  // current at open time.
  const focusIndexRef = useRef(focusIndex);
  focusIndexRef.current = focusIndex;
  const choicesRef = useRef(choices);
  choicesRef.current = choices;

  const onSelectRef = useRef<{
    own: () => void;
    pool: (id: string) => void;
    profile: ((id: string) => void) | undefined;
  }>({ own: onSelectConfigured, pool: onSelectPool, profile: onSelectProfile });
  const onCloseRef = useRef(() => setOpen(false));
  onSelectRef.current = {
    own: onSelectConfigured,
    pool: onSelectPool,
    profile: onSelectProfile,
  };
  onCloseRef.current = () => setOpen(false);

  const pick = (id: string): void => {
    if (id === OWN_MODEL_ID) onSelectRef.current.own();
    else if (id.startsWith(PROFILE_PREFIX)) onSelectRef.current.profile?.(id.slice(PROFILE_PREFIX.length));
    else onSelectRef.current.pool(id);
    onCloseRef.current();
  };

  useEffect(() => {
    if (!open) return;
    navigationRef.current = 'keyboard';
    setFocusIndex(currentIndex);
  }, [open, currentIndex]);

  // Anchored placement: portal to body, flip above/below the chip —
  // mirrors ModePopover's layout effect so the popover is never
  // clipped by the viewport top or a short window.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const menu = listRef.current;
      const anchor = anchorRef.current;
      if (!menu || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 12, gap = 8;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportBottom = viewportTop + viewportHeight;
      const above = Math.max(0, rect.top - gap - viewportTop - margin);
      const below = Math.max(0, viewportBottom - rect.bottom - gap - margin);
      const border = menu.offsetHeight - menu.clientHeight;
      const naturalHeight = menu.scrollHeight + border;
      const down = below >= Math.min(naturalHeight, 480) || below > above;
      const maxHeight = Math.min(480, down ? below : above);
      const height = Math.min(naturalHeight, maxHeight);
      Object.assign(menu.style, {
        left: `${Math.max(margin, Math.min(rect.left, window.innerWidth - menu.offsetWidth - margin))}px`,
        top: `${Math.max(viewportTop + margin, Math.min(down ? rect.bottom + gap : rect.top - height - gap, viewportBottom - height - margin))}px`,
        maxHeight: `${maxHeight}px`,
      });
    };
    const onScroll = (event: Event): void => {
      // Scrolling the menu must not reposition it under the pointer.
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      place();
    };
    place();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : undefined;
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (listRef.current) {
      observer?.observe(listRef.current);
      for (const group of listRef.current.children) observer?.observe(group);
    }
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, choices.length, platform.loading, platform.message]);

  useLayoutEffect(() => {
    if (!open || navigationRef.current !== 'keyboard') return;
    const menu = listRef.current;
    const option = menu?.querySelectorAll<HTMLElement>('[role="option"]')[focusIndex];
    if (!menu || !option) return;
    const bounds = menu.getBoundingClientRect(), item = option.getBoundingClientRect();
    const top = bounds.top + menu.clientTop;
    const bottom = top + menu.clientHeight;
    // Move this scroll container only; scrollIntoView can also move the chat.
    if (item.top < top) menu.scrollTop -= top - item.top;
    else if (item.bottom > bottom) menu.scrollTop += item.bottom - bottom;
  }, [open, focusIndex, choices.length, platform.loading]);

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
        navigationRef.current = 'keyboard';
        setFocusIndex((i) => (i + 1) % choicesRef.current.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigationRef.current = 'keyboard';
        setFocusIndex((i) => (i - 1 + choicesRef.current.length) % choicesRef.current.length);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        navigationRef.current = 'keyboard';
        setFocusIndex(e.key === 'Home' ? 0 : choicesRef.current.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = choicesRef.current[focusIndexRef.current];
        if (c) pick(c.id);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // Listeners stay bound for the whole open session; fresh values
    // arrive through the refs above. `pick` closes the popover, which
    // re-runs this guarded effect on the next open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chipLabel = poolModel.trim()
    ? labelForModel(poolModel)
    : activeProfile
      ? activeProfile.label
      : configuredModel
        ? labelForModel(configuredModel)
        : '默认模型';

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
        <span className="model-selector__chip-label">{chipLabel}</span><ChevronDown size={12} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            className="model-selector__popover mode-popover mode-popover--anchored"
            role="listbox"
            aria-label="Select model"
            tabIndex={-1}
          >
            {GROUPS.map((group, groupIndex) => {
              const rows = choices.filter((c) => c.group === group.key);
              return (
                <div key={group.key} role="group" aria-label={group.title}>
                  {groupIndex > 0 && <div className="model-selector__divider" />}
                  <span className="model-selector__group-heading">{group.title}</span>
                  {group.key === 'pool' && (platform.loading || platform.message) && <p role="status" className="model-selector__status">{platform.loading ? '正在同步账号模型…' : platform.message}</p>}
                  {group.key === 'pool' && !platform.loading && platform.models.length > 0 && currentPoolId && !platform.models.some(model => model.id === currentPoolId) && <p role="status" className="model-selector__status">所选模型已不可用，请重新选择</p>}
                  <ul className="model-selector__list" role="presentation">
                    {rows.map((c) => {
                      const i = choices.indexOf(c);
                      const active = i === focusIndex;
                      const current = c.id === currentId;
                      return (
                        <li
                          key={c.id}
                          role="option"
                          aria-selected={current}
                          className={`model-selector__item${active ? ' model-selector__item--focus' : ''}${current ? ' model-selector__item--current' : ''}`}
                          onMouseEnter={() => { navigationRef.current = 'pointer'; setFocusIndex(i); }}
                          onClick={() => pick(c.id)}
                        >
                          <span className="model-selector__check" aria-hidden="true">
                            {current && <Check size={14} />}
                          </span>
                          <span className="model-selector__label" title={c.label}>{c.label}</span>
                          <span className="model-selector__hint">{c.hint}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
