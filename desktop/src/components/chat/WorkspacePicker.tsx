import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, FolderPlus } from 'lucide-react';
import { WorkspaceNavigationContext } from '../app-shell/WorkspaceNavigationContext';
import { WorkspaceFolderIcon } from '../app-shell/WorkspaceFolderIcon';

export function WorkspacePicker(props: { readonly workspace?: string }): ReactElement | null {
  const navigation = useContext(WorkspaceNavigationContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = navigation?.workspaces.find(item => item.id === navigation.currentWorkspaceId);
  const name = current?.name ?? props.workspace?.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
  const close = useCallback((): void => { setOpen(false); trigger.current?.focus(); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const popup = menu.current, anchor = trigger.current;
      if (!popup || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const above = rect.top - 16, below = window.innerHeight - rect.bottom - 16;
      const down = below >= popup.scrollHeight || below >= above;
      const maxHeight = Math.max(80, down ? below : above);
      const height = Math.min(popup.scrollHeight, maxHeight);
      Object.assign(popup.style, {
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`,
        top: `${down ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)}px`,
        maxHeight: `${maxHeight}px`,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector('button'))?.focus();
    const outside = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  // A workspace change elsewhere must not leave a stale popup over the new conversation.
  useEffect(() => { setOpen(false); }, [navigation?.currentWorkspaceId]);

  if (!navigation) return name ? <span className="input-bar__workspace" title={props.workspace}>
    <WorkspaceFolderIcon open={false} /><span className="workspace-picker__name">{name}</span>
  </span> : null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key === 'Tab') close();
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return <>
    <button ref={trigger} type="button" className="input-bar__workspace workspace-picker__trigger"
      title={current?.root ?? props.workspace} aria-label={`切换工作区：${name ?? '选择项目'}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      <WorkspaceFolderIcon open={open} /><span className="workspace-picker__name">{name ?? '选择项目'}</span><ChevronDown size={12} />
    </button>
    {open && createPortal(<div ref={menu} id={id} className="workspace-picker__menu" role="menu" aria-label="切换工作区" onKeyDown={onKeyDown}>
      <div className="workspace-picker__heading">工作区</div>
      {navigation.workspaces.map(item => <button type="button" role="menuitemradio" key={item.id}
        aria-checked={item.id === navigation.currentWorkspaceId} onClick={() => { close(); if (item.id !== navigation.currentWorkspaceId) navigation.onSwitchWorkspace(item.id); }}>
        <WorkspaceFolderIcon open={item.id === navigation.currentWorkspaceId} />
        <span className="workspace-picker__entry"><span>{item.name}</span><small>{item.root}</small></span>
        {item.id === navigation.currentWorkspaceId && <Check size={14} />}
      </button>)}
      <div className="workspace-picker__divider" />
      <button type="button" role="menuitem" onClick={() => { close(); navigation.onOpenFolder(); }}><FolderPlus size={16} /><span>打开其他项目…</span></button>
    </div>, document.body)}
  </>;
}
