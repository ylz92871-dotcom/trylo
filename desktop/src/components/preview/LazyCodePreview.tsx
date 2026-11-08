import { lazy, Suspense, type ReactElement } from 'react';

const Reader = lazy(() => import('./CodePreview').then(module => ({ default: module.CodePreview })));

/** Rich previews share the code reader without loading Monaco until source is opened. */
export function LazyCodePreview({ path, content }: { path: string; content: string }): ReactElement {
  return <Suspense fallback={<div className="preview__empty" role="status">正在加载代码…</div>}>
    <Reader key={path} path={path} content={content} />
  </Suspense>;
}
