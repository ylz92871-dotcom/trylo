// Trylo Desktop — TextPreview (base capability).
//
// The fallback renderer: line-numbered plain text for code, JSON,
// logs, and anything without a richer view. Extracted verbatim from
// FilePeek's old inline body so the fallback has exactly one owner.

import type { ReactElement } from 'react';

export interface TextPreviewProps {
  readonly content: string;
}

function splitLines(content: string): string[] {
  if (content === '') return [''];
  return content.split('\n');
}

export function TextPreview(props: TextPreviewProps): ReactElement {
  const lines = splitLines(props.content);
  return (
    <div className="file-peek__body" role="region" aria-label="File content">
      <pre className="file-peek__code">
        {lines.map((line, i) => (
          <div key={i} className="file-peek__line">
            <span className="file-peek__lineno">{i + 1}</span>
            <span className="file-peek__linetext">{line === '' ? ' ' : line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
