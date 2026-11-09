// Headless conversion keeps fonts, filters and hyphenation for every language.
// Editing aids and translated application chrome do not belong in this runtime.
import path from 'node:path';

export const officeRuntimeProfile = 'headless-preview-zh-en-v1';
const resourceLocales = new Set(['common', 'en_US', 'en_GB', 'zh_CN', 'zh_TW']);
const registryLocales = new Set(['en-US', 'en-GB', 'zh-CN', 'zh-TW']);

export function includesOfficeFile(relative) {
  const parts = relative.split('/');
  if (relative.startsWith('program/resource/')) return resourceLocales.has(parts[2]);
  if (relative.startsWith('share/registry/res/')) {
    const locale = parts[3].match(/^(?:fcfg_langpack|registry)_(.+)\.xcd$/)?.[1];
    return !locale || registryLocales.has(locale);
  }
  if (/^(?:help|share\/(?:gallery|template))\//.test(relative)) return false;
  if (/^share\/config\/images_[^/]+\.zip$/.test(relative)) return relative === 'share/config/images_colibre.zip';
  return !/^share\/extensions\/(?:nlpsolver|wiki-publisher)\//.test(relative);
}

export function trimDictionaryConfig(relative, original) {
  const removedFiles = new Set();
  // These pinned XCU files use leaf nodes for each dictionary. Keep the XML
  // envelope and every DICT_HYPH node unchanged, including its locale aliases.
  const text = original.replace(/<node\b[^>]*>(?:(?!<node\b)[\s\S])*?<\/node>/g, node => {
    if (!/<value>\s*DICT_(?:SPELL|THES)\s*<\/value>/.test(node)) return node;
    const locations = node.match(/<prop\b[^>]*oor:name="Locations"[^>]*>([\s\S]*?)<\/prop>/)?.[1];
    if (!locations) throw new Error(`Dictionary locations missing: ${relative}`);
    for (const match of locations.matchAll(/%origin%\/([^\s<]+)/g)) {
      const file = path.posix.join(path.posix.dirname(relative), match[1]);
      if (!file.startsWith(`${path.posix.dirname(relative)}/`)) throw new Error(`Dictionary path escaped: ${relative}`);
      removedFiles.add(file);
    }
    return '';
  });
  if (/<value>\s*DICT_(?:SPELL|THES)\s*<\/value>/.test(text)) throw new Error(`Unsupported dictionary XML: ${relative}`);
  return { bytes: Buffer.from(text), removedFiles };
}

export async function planOfficeRuntime(files, readBytes) {
  const replacements = new Map();
  const removed = new Set();
  const available = new Set(files.map(file => file.path));
  for (const file of files) {
    if (!/^share\/extensions\/dict-[^/]+\/dictionaries\.xcu$/.test(file.path)) continue;
    const result = trimDictionaryConfig(file.path, (await readBytes(file.path)).toString('utf8'));
    for (const relative of result.removedFiles) {
      if (!available.has(relative)) throw new Error(`Pinned dictionary resource missing: ${relative}`);
      removed.add(relative);
    }
    replacements.set(file.path, result.bytes);
  }
  return {
    files: files.filter(file => includesOfficeFile(file.path) && !removed.has(file.path)),
    replacements,
  };
}
