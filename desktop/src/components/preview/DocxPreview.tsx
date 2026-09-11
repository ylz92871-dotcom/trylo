// Trylo Desktop — DocxPreview (base capability).
//
// docx-preview (Apache-2.0) renders OOXML Word into HTML. Fluid layout
// (no page breaks, no fixed width) fits the 480px rail better than
// paginated paper; embedded images load via object URLs the library
// mints itself. jsdom can't run it, so this is typechecked + manually
// verified; routing is covered in previewKind.test.ts.

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { usePreviewBytes } from './usePreviewBytes';

export interface DocxPreviewProps {
  readonly path: string;
}

export function DocxPreview(props: DocxPreviewProps): ReactElement {
  const bytesState = usePreviewBytes(props.path);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const container = bodyRef.current;
    if (bytesState.status !== 'ready' || !container) return undefined;
    let cancelled = false;
    setError('');
    container.innerHTML = '';
    // A Blob (not the raw buffer) is the friendliest input: the library
    // hands images back as object URLs either way.
    const blob = new Blob([bytesState.bytes as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    renderAsync(blob, container, undefined, {
      className: 'trylo-docx',
      inWrapper: false,
      ignoreWidth: true,
      ignoreHeight: true,
      breakPages: false,
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
      container.innerHTML = '';
    };
  }, [bytesState]);

  if (bytesState.status === 'loading') {
    return <div className="preview__empty">Loading document…</div>;
  }
  if (bytesState.status === 'error') {
    return <div className="preview__empty">Could not load document: {bytesState.message}</div>;
  }
  if (error !== '') {
    return <div className="preview__empty">Could not render document: {error}</div>;
  }
  return <div ref={bodyRef} className="preview__docx" role="region" aria-label="Word preview" />;
}
