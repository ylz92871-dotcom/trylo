import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Goal, Paperclip, Plus } from 'lucide-react';

export function ComposerActions(props: { readonly onAdd: () => void; readonly onGoal: () => void }): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const close = (): void => { setOpen(false); anchor.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !anchor.current || !menu.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const height = menu.current.offsetHeight;
    const top = rect.top >= height + 16 ? rect.top - height - 8 : rect.bottom + 8;
    Object.assign(menu.current.style, {
      left: `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.current.offsetWidth - 8))}px`,
      top: `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`,
    });
    menu.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = (): void => setOpen(false);
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [open]);
  return <><button ref={anchor} type="button" className="input-bar__attach" title="添加文件或设置目标" aria-label="添加和设置" aria-haspopup="menu" aria-controls={open ? menuId : undefined} aria-expanded={open} onClick={() => setOpen(value => !value)}><Plus size={19} strokeWidth={1.8} /></button>
    {open && createPortal(<div ref={menu} id={menuId} className="composer-actions" role="menu" aria-label="添加和设置" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key === 'Tab') setOpen(false);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}><button type="button" role="menuitem" onClick={() => { close(); props.onAdd(); }}><Paperclip size={17} strokeWidth={1.6} /><span>添加文件或图片</span></button>
      <button type="button" role="menuitem" onClick={() => { close(); props.onGoal(); }}><Goal size={17} strokeWidth={1.6} /><span>设置目标</span><small>/goal</small></button>
      <div className="composer-actions__hint">也可以粘贴或拖入图片</div></div>, document.body)}</>;
}
