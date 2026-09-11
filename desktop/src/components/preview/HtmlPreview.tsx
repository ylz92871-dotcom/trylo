// Trylo Desktop — HtmlPreview (base capability).
//
// WHY srcDoc + sandbox instead of a reader view: Work delivers
// real pages (e.g. `.trylo/out/landing-page.html`) and Code peeks at
// app sources — both need to SEE the rendered page, not its source.
// `sandbox=""` (empty = no scripts, no same-origin, no forms) keeps an
// untrusted artifact from touching the shell even if it contains JS.
// Scripts are intentionally disabled: this is a static glance, not a
// browser. Interactive debugging belongs to the shell-level Browser
// Preview drawer (use-browser-preview.ts), which is a separate,
// explicitly-started live viewport.

import type { ReactElement } from 'react';

export interface HtmlPreviewProps {
  readonly content: string;
  readonly title: string;
}

export function HtmlPreview(props: HtmlPreviewProps): ReactElement {
  return (
    <iframe
      className="preview__html"
      title={props.title}
      sandbox=""
      srcDoc={props.content}
    />
  );
}
