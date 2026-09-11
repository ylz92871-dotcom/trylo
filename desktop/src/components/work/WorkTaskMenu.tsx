// Trylo Desktop — WorkTaskMenu.
//
// v1.17.2: replaces the explicit "任务" pill under the Work
// composer. A single "+" button opens a small popover of
// common deliverable shapes (PPT, Word, sheet, organize, etc.).
// Picking one writes a starter work order into the composer
// input so the user can review before sending.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Plus } from 'lucide-react';

export interface WorkTaskMenuProps {
  /** Called with the selected starter prompt to run as a task. */
  readonly onRunTask: (prompt: string) => void;
}

interface TaskItem {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

const TASK_ITEMS: readonly TaskItem[] = [
  {
    id: 'ppt',
    label: 'PPT 演示文稿',
    prompt: 'Create a PowerPoint presentation that summarizes the key content in this workspace.',
  },
  {
    id: 'word',
    label: 'Word 文档',
    prompt: 'Write a comprehensive Word document based on the files in this workspace.',
  },
  {
    id: 'sheet',
    label: '数据表格',
    prompt: 'Build a structured spreadsheet from the data in this workspace.',
  },
  {
    id: 'organize',
    label: '整理文件',
    prompt: 'Organize the files in this workspace: rename, categorize, and clean up the folder structure.',
  },
  {
    id: 'general',
    label: '通用任务',
    prompt: 'Help me deliver something useful from this workspace.',
  },
];

export function WorkTaskMenu(props: WorkTaskMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const select = (item: TaskItem): void => {
    setOpen(false);
    props.onRunTask(item.prompt);
  };

  return (
    <div className="work-task-menu" ref={ref}>
      <button
        type="button"
        className="work-task-menu__trigger"
        title="选择任务类型"
        aria-label="选择任务类型"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open && (
        <div className="work-task-menu__popover" role="menu">
          {TASK_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="work-task-menu__item"
              role="menuitem"
              onClick={() => select(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
