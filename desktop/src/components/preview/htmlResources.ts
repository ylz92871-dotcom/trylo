import { readPreviewResource } from '../../host-adapter/preview/resources';

import { localResourcePath } from '../../host-adapter/preview/resource-path';
export { localResourcePath } from '../../host-adapter/preview/resource-path';
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };

export async function prepareHtml(content: string, documentPath: string, root: string, signal: AbortSignal): Promise<{ html: string; warnings: readonly string[] }> {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const warnings = new Set<string>();
  const cache = new Map<string, Promise<Uint8Array>>();
  let total = 0;
  doc.querySelectorAll('base, meta[http-equiv="refresh" i]').forEach((el) => el.remove());
  const read = (file: string): Promise<Uint8Array> => {
    if (signal.aborted) throw new Error('已取消');
    const previous = cache.get(file);
    if (previous) return previous;
    if (cache.size >= 64) throw new Error('本地资源超过 64 个');
    const pending = readPreviewResource(file, root).then((bytes) => { total += bytes.byteLength; if (total > 40 * 1024 * 1024) throw new Error('资源总量超过 40 MB'); return bytes; });
    cache.set(file, pending); return pending;
  };
  const embed = async (reference: string, base: string): Promise<string> => {
    if (/^(data:|https?:|blob:|#|\/\/)/i.test(reference)) return reference;
    const file = localResourcePath(base, root, reference);
    if (!file) { warnings.add(reference); return ''; }
    try {
      const bytes = await read(file);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const extension = file.split('.').pop()?.toLowerCase() ?? '';
      return `data:${MIME[extension] ?? 'application/octet-stream'};base64,${btoa(binary)}${reference.includes('#') ? '#' + reference.split('#')[1] : ''}`;
    } catch { warnings.add(reference); return ''; }
  };
  const css = async (text: string, base: string, depth = 0): Promise<string> => {
    // Imported local styles are resolved relative to their own file.
    const imports = [...text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?([^;]*);/gi)];
    for (const match of imports) {
      const file = localResourcePath(base, root, match[1]!);
      if (!file || depth >= 4) { warnings.add(match[1]!); text = text.replace(match[0], ''); continue; }
      try { const nested = await css(new TextDecoder().decode(await read(file)), file, depth + 1); text = text.replace(match[0], match[2]?.trim() ? `@media ${match[2]} {${nested}}` : nested); }
      catch { warnings.add(match[1]!); text = text.replace(match[0], ''); }
    }
    const urls = [...text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
    for (const match of urls) text = text.replace(match[0], `url("${await embed(match[2]!.trim(), base)}")`);
    return text;
  };
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')) {
    const ref = link.getAttribute('href') ?? '';
    const file = localResourcePath(documentPath, root, ref);
    if (!file) continue;
    try { const style = doc.createElement('style'); style.textContent = await css(new TextDecoder().decode(await read(file)), file); link.replaceWith(style); }
    catch { warnings.add(ref); link.remove(); }
  }
  for (const style of doc.querySelectorAll('style')) style.textContent = await css(style.textContent ?? '', documentPath);
  for (const element of doc.querySelectorAll('[style]')) element.setAttribute('style', await css(element.getAttribute('style') ?? '', documentPath));
  for (const element of doc.querySelectorAll('img[src], image[href], video[poster]')) {
    const attribute = element.hasAttribute('poster') ? 'poster' : element.hasAttribute('href') ? 'href' : 'src';
    element.setAttribute(attribute, await embed(element.getAttribute(attribute) ?? '', documentPath));
  }
  for (const element of doc.querySelectorAll('img[srcset], source[srcset]')) {
    const entries = (element.getAttribute('srcset') ?? '').split(',');
    if (entries.some((entry) => entry.trim().startsWith('data:'))) continue;
    const converted = [];
    for (const entry of entries) { const [url, ...descriptor] = entry.trim().split(/\s+/); if (url) converted.push([await embed(url, documentPath), ...descriptor].join(' ')); }
    element.setAttribute('srcset', converted.join(', '));
  }
  return { html: '<!doctype html>' + doc.documentElement.outerHTML, warnings: [...warnings] };
}
