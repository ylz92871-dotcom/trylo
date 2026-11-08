interface ReferenceNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: ReferenceNode[];
  properties?: Record<string, unknown>;
}

const FILE_MENTION = /^(?:[a-z]:[\\/]|\.?\.?[\\/])?[^\n`<>]+\.(?:md|txt|json|ya?ml|toml|tsx?|jsx?|css|html?|py|rs|go|java|c|cpp|h|hpp|pptx?|xlsx?|docx?|pdf|csv|svg|png|jpe?g|webp|gif)$/i;
const normalized = (path: string): string => path.replace(/\\/g, '/');
export const fileReferenceName = (path: string): string => normalized(path).split('/').at(-1) ?? path;

export function localFileHref(href: string): string | undefined {
  if (!href || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href)) return undefined;
  let path = href;
  try { path = decodeURI(href); } catch { /* A literal percent sign is allowed in a path. */ }
  return FILE_MENTION.test(path) ? path : undefined;
}

export function referenceProperty(node: ReferenceNode | undefined, name: string): string | undefined {
  const value = node?.properties?.[name];
  return typeof value === 'string' ? value : undefined;
}

function nodeText(node: ReferenceNode): string {
  return node.value ?? node.children?.map(nodeText).join('') ?? '';
}

function directoryLabel(path: string, peers: ReadonlySet<string>): string {
  const parent = (value: string): string => value.slice(0, Math.max(0, value.lastIndexOf('/')));
  const directory = parent(path);
  if (!directory) return '目录未注明';
  const parts = directory.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const suffix = parts.slice(-depth).join('/');
    if ([...peers].every(peer => peer === path || parent(peer).split('/').slice(-depth).join('/') !== suffix)) return suffix;
  }
  return directory;
}

/** Syntax-tree context keeps code fences and code inside links out of button rendering. */
export function rehypeFileReferences() {
  return (tree: ReferenceNode): void => {
    const references: { node: ReferenceNode; path: string; caption?: string }[] = [];
    const visit = (node: ReferenceNode, inPre = false, inLink = false): void => {
      const pre = inPre || node.tagName === 'pre';
      const link = inLink || node.tagName === 'a';
      if (!pre && node.tagName === 'code' && !inLink) {
        const path = nodeText(node).trim();
        const protocol = /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path);
        if (!protocol && FILE_MENTION.test(path)) references.push({ node, path });
      } else if (!pre && node.tagName === 'a') {
        const href = referenceProperty(node, 'href');
        const path = href ? localFileHref(href) : undefined;
        if (path) references.push({ node, path, caption: nodeText(node) });
      }
      node.children?.forEach(child => visit(child, pre, link));
    };
    visit(tree);
    const byName = new Map<string, Set<string>>();
    for (const { path } of references) {
      const name = fileReferenceName(path).toLowerCase();
      const paths = byName.get(name) ?? new Set<string>();
      paths.add(normalized(path));
      byName.set(name, paths);
    }
    for (const { node, path, caption } of references) {
      const peers = byName.get(fileReferenceName(path).toLowerCase());
      node.properties = { ...node.properties, 'data-file-reference': path,
        ...(caption !== undefined ? { 'data-file-caption': caption } : {}),
        ...(peers && peers.size > 1 ? { 'data-file-directory': directoryLabel(normalized(path), peers) } : {}),
      };
    }
  };
}
