import type { ReactElement, ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { fileReferenceName } from './file-references';

export interface InlineFileReferenceProps {
  readonly path: string;
  readonly label?: ReactNode;
  readonly accessibleName?: string;
  readonly directory?: string;
  readonly href?: string;
  readonly onOpen: () => void;
}

export function InlineFileReference(props: InlineFileReferenceProps): ReactElement {
  const name = fileReferenceName(props.path);
  const dot = name.lastIndexOf('.');
  const filename = dot > 0 ? <>
    <span className="message__artifact-stem">{name.slice(0, dot)}</span>
    <span className="message__artifact-extension">{name.slice(dot)}</span>
  </> : name;
  const content = <>
    <FileText size={14} aria-hidden="true" />
    <span className={`message__artifact-name${(props.label === null || props.label === undefined) ? ' message__artifact-name--file' : ''}`}>{props.label ?? filename}</span>
    {props.directory && <span className="message__artifact-directory" aria-hidden="true">· {props.directory}</span>}
  </>;
  const attributes = {
    className: 'message__artifact-link',
    title: `在右侧打开 ${props.path}`,
    'aria-label': props.accessibleName ?? props.path,
  };
  return props.href !== undefined ? (
    <a {...attributes} href={props.href} onClick={event => { event.preventDefault(); props.onOpen(); }}>{content}</a>
  ) : (
    <button {...attributes} type="button" onClick={props.onOpen}>{content}</button>
  );
}
