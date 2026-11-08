import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

export interface ArtifactMenuAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
  readonly icon?: LucideIcon;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly separator?: boolean;
}

interface ArtifactCardMenuProps {
  readonly anchor: RefObject<HTMLDivElement>;
  readonly actions: readonly ArtifactMenuAction[];
  readonly onDismiss: () => void;
}

/** Portaling keeps the action list outside the conversation's clipped scroll area. */
export function ArtifactCardMenu({ anchor, actions, onDismiss }: ArtifactCardMenuProps): JSX.Element | null {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    const place = () => {
      const bounds = anchor.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = 250;
      const edge = 12;
      setPosition({
        top: bounds.bottom + 8,
        left: Math.min(Math.max(edge, bounds.right - width), window.innerWidth - width - edge),
      });
    };
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (menu.current?.contains(target) || anchor.current?.contains(target))) return;
      onDismiss();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('pointerdown', dismissOutside);
    window.addEventListener('keydown', dismissWithKeyboard);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('pointerdown', dismissOutside);
      window.removeEventListener('keydown', dismissWithKeyboard);
    };
  }, [anchor, onDismiss]);

  if (!position) return null;
  return createPortal(
    <div ref={menu} className="artifact-card__menu" role="menu" style={{ top: position.top, left: position.left }}>
      {actions.map(({ id, label, run, icon: Icon, disabled, title, separator }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          className={separator ? 'artifact-card__menu-final' : undefined}
          disabled={disabled}
          title={title}
          onClick={() => { onDismiss(); run(); }}
        >
          {Icon && <Icon size={14} />}
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
