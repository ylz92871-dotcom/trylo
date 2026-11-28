/** Resolve workspace-relative companion files. Native/dev hosts also prove
 * containment after canonicalization, including junction/symlink targets. */
export function localResourcePath(documentPath: string, root: string, reference: string): string | undefined {
  let ref: string;
  try { ref = decodeURIComponent(reference.split(/[?#]/)[0] ?? ''); } catch { return undefined; }
  // eslint-disable-next-line no-control-regex -- Intentionally reject control bytes or strip ANSI escapes.
  if (!ref || /^[a-z][a-z\d+.-]*:|^[\\/]/i.test(ref) || /[\x00-\x1f]/.test(ref)) return undefined;
  const base = documentPath.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const part of ref.replace(/\\/g, '/').split('/')) {
    if (part === '..') base.pop(); else if (part && part !== '.') base.push(part);
  }
  const target = base.join('/');
  const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  const windows = /^[a-z]:/i.test(prefix);
  return (windows ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix)) ? target : undefined;
}
