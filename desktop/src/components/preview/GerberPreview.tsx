// Trylo Desktop — GerberPreview (base capability).
//
// Single-layer glance at Gerber/drill exports (tracespace MIT stack).
// Copper renders in currentColor on a solder-mask backdrop — the look
// of a fab viewer, not a white page. Text-based format: uses the
// UTF-8 `content` FilePeek already loaded.

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { gerberToSvgString } from './gerberSvg';

export interface GerberPreviewProps {
  readonly path: string;
  readonly content: string;
}

type GerberState =
  | { readonly status: 'working' }
  | { readonly status: 'ready'; readonly svg: string }
  | { readonly status: 'error'; readonly message: string };

export function GerberPreview(props: GerberPreviewProps): ReactElement {
  const [state, setState] = useState<GerberState>({ status: 'working' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'working' });
    const id = props.path.split(/[\\/]/).pop() ?? 'gerber';
    gerberToSvgString(props.content, id).then(
      (svg) => {
        if (!cancelled) setState({ status: 'ready', svg });
      },
      (err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.content, props.path]);

  if (state.status === 'working') {
    return <div className="preview__empty">Rendering Gerber…</div>;
  }
  if (state.status === 'error') {
    return <div className="preview__empty">Could not render Gerber: {state.message}</div>;
  }
  return (
    <div className="preview__paged" role="region" aria-label="Gerber preview">
      <div
        className="preview__gerber"
        // Built by gerber-to-svg from plotter geometry, escaped by the
        // library — never file HTML.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
      <div className="preview__fold-note">Single layer — stack the full set in your CAM tool for the whole board.</div>
    </div>
  );
}
