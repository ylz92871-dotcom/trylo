import type { ReactElement } from 'react';

export function WorkspaceFolderIcon(props: { readonly open: boolean; readonly size?: number }): ReactElement {
  return <svg className="workspace-folder" data-open={props.open} width={props.size ?? 16} height={props.size ?? 16}
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path className="workspace-folder__back" d="M3 10V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v3" />
    <path className="workspace-folder__front" d="M3 9h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
  </svg>;
}
