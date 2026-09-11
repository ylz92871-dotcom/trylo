// Trylo Desktop — DxfPreview (base capability).
//
// 2D CAD glance: dxf-parser (MIT) + our dxfSvg projection, injected as
// SVG. Text-based format, so the UTF-8 `content` FilePeek already
// loaded is the input — no byte fetch. The caption reports rendered
// vs skipped entities; INSERT/block content is counted, not faked.

import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { dxfToSvg } from './dxfSvg';

export interface DxfPreviewProps {
  readonly content: string;
}

export function DxfPreview(props: DxfPreviewProps): ReactElement {
  const result = useMemo(() => dxfToSvg(props.content), [props.content]);

  if (result.svg === '') {
    return (
      <div className="preview__empty">
        Could not parse this DXF — it may be binary, corrupt, or larger than the preview cap.
      </div>
    );
  }

  return (
    <div className="preview__paged" role="region" aria-label="CAD preview">
      <div
        className="preview__cad"
        // The SVG is built by our own projector (escaping included),
        // never from file HTML — no script can arrive through it.
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
      <div className="preview__fold-note">
        {result.rendered} entit{result.rendered === 1 ? 'y' : 'ies'} shown
        {result.skipped > 0 ? ` · ${result.skipped} skipped (blocks/dimensions/hatch)` : ''}
        {result.approximated ? ' · bulged segments straightened' : ''}
      </div>
    </div>
  );
}
