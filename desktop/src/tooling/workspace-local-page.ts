import { canonicalizeCwd } from './runtime-fingerprint';

export const INVALID_BROWSER_NAVIGATION_URL_MESSAGE =
  '导航地址无效：请提供完整的 http(s) URL，或工作区内公开 HTML 页面的本地 file URL。其他协议不受支持。';
export const BROWSER_WORKSPACE_FILE_SCOPE_MESSAGE =
  'Denied: browser files must stay inside the workspace; local HTML previews allow public files and .trylo/out only, without hosted file URLs or private hidden paths.';

export type WorkspacePageUrl =
  | { readonly kind: 'not-local' }
  | { readonly kind: 'local'; readonly path: string; readonly display: string }
  | { readonly kind: 'invalid'; readonly reasonCode: 'invalid_url' | 'path_outside_workspace'; readonly failureCode?: 'invalid_arguments' };

const malformed = (): WorkspacePageUrl => ({ kind: 'invalid', reasonCode: 'invalid_url', failureCode: 'invalid_arguments' });
const outside = (): WorkspacePageUrl => ({ kind: 'invalid', reasonCode: 'path_outside_workspace' });

/** Lexical eligibility only. The managed preview rechecks real paths before
 * reading the page and every asset, including symlink/reparse containment. */
export function analyzeWorkspacePageUrl(raw: unknown, projectRoot: string): WorkspacePageUrl {
  if (typeof raw !== 'string' || !/^file:/i.test(raw.trim())) return { kind: 'not-local' };
  const value = raw.trim();
  // WHATWG normalizes file://localhost to an empty host. Reject the supplied
  // authority as well so no hosted/UNC form acquires local-file authority.
  const authority = /^file:\/\/([^/\\]*)/i.exec(value)?.[1];
  if (authority) return outside();

  let pathname: string;
  try {
    const url = new URL(value);
    if (url.hostname) return outside();
    // Node's fileURLToPath rejects encoded separators too; do not admit a
    // command that the actual preview cannot interpret with the same path.
    if (/%2f|%5c/i.test(url.pathname)) return malformed();
    pathname = decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:\/)/, '$1');
  } catch {
    return malformed();
  }
  // eslint-disable-next-line no-control-regex -- Deliberately reject all C0 control characters in paths and labels.
  if (/[\u0000-\u001f\u007f]/.test(pathname) || !/\.html?$/i.test(pathname)) return malformed();
  if (pathname.startsWith('//') || pathname.includes('\\')) return outside();

  const root = canonicalizeCwd(projectRoot);
  const windows = /^[a-zA-Z]:(?:\/|$)/.test(root);
  const key = (path: string): string => windows ? path.toLowerCase() : path;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!root || !key(pathname).startsWith(key(prefix))) return outside();
  const display = pathname.slice(prefix.length);
  const segments = display.split('/');
  if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) return outside();
  const publicOutput = key(segments[0] ?? '') === '.trylo' && key(segments[1] ?? '') === 'out' && segments.length > 2;
  if (segments.some((segment, index) => segment.startsWith('.') && !(publicOutput && index === 0))) return outside();
  if (windows && segments.some(segment => segment.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) return outside();

  return { kind: 'local', path: pathname, display };
}
