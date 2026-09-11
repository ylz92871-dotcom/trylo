// Trylo Desktop — MarkdownPreview (base capability).
//
// The SAME renderer backs chat markdown (Message.tsx) and file peeks:
// react-markdown WITHOUT rehype-raw, so embedded HTML in the source is
// shown as text, never executed. One file, one concept — formatting
// tweaks for markdown previews belong here, not in FilePeek.

import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';

export interface MarkdownPreviewProps {
  readonly content: string;
}

export function MarkdownPreview(props: MarkdownPreviewProps): ReactElement {
  return (
    <div className="preview__markdown" role="region" aria-label="Markdown preview">
      <ReactMarkdown>{props.content}</ReactMarkdown>
    </div>
  );
}
