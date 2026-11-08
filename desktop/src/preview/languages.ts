/** Pure source-file metadata; no editor or filesystem imports in discovery. */
import catalog from './languages.generated.json';
import additional from './languages.extra.json';

export interface SourceLanguage {
  readonly id: string;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly filenames: readonly string[];
  readonly firstLine?: string;
}
export const SOURCE_LANGUAGES: readonly SourceLanguage[] = [
  { id: 'plaintext', label: '纯文本', extensions: ['.txt', '.log'], filenames: [] },
  ...catalog.languages,
  ...additional,
];
const named: Record<string, string> = {
  justfile: 'shell',
  containerfile: 'dockerfile', gemfile: 'ruby', rakefile: 'ruby', brewfile: 'ruby',
  '.bashrc': 'shell', '.bash_profile': 'shell', '.zshrc': 'shell', '.profile': 'shell',
  '.env': 'ini', '.env.example': 'ini', '.editorconfig': 'ini', '.gitignore': 'plaintext',
};
const aliases: Record<string, string> = {
  '.vue': 'html', '.svelte': 'html', '.astro': 'html', '.toml': 'toml', '.m': 'matlab',
  '.conf': 'ini', '.cfg': 'ini', '.zsh': 'shell', '.bash': 'shell',
  '.cjs': 'javascript', '.mjs': 'javascript', '.cjsx': 'javascript',
  '.mdown': 'markdown', '.mkd': 'markdown', '.jsonc': 'json', '.jsonl': 'json', '.ndjson': 'json',
};
const extensions = SOURCE_LANGUAGES.flatMap((language) => language.extensions.map((ext) => ({ ext: ext.toLowerCase(), id: language.id })))
  .sort((a, b) => b.ext.length - a.ext.length);
export function sourceLanguageFor(path: string, content = ''): SourceLanguage {
  const name = path.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase();
  let id = named[name] ?? SOURCE_LANGUAGES.find((language) => language.filenames.some((file) => file.toLowerCase() === name))?.id;
  id ??= Object.entries(aliases).find(([ext]) => name.endsWith(ext))?.[1];
  id ??= extensions.find((entry) => name.endsWith(entry.ext))?.id;
  if (name.endsWith('.m') && /(?:^|\n)\s*(?:@(?:interface|implementation|protocol)\b|#import\b)/.test(content.slice(0, 8192))) id = 'objective-c';
  if (!id || id === 'plaintext') {
    const firstLine = content.slice(0, 1000).split(/\r?\n/, 1)[0]!;
    id = SOURCE_LANGUAGES.find((language) => language.firstLine && new RegExp(language.firstLine).test(firstLine))?.id ?? id;
    if (!id && /^#!.*\b(?:ba|z|fi|k)?sh\b/.test(firstLine)) id = 'shell';
  }
  return SOURCE_LANGUAGES.find((language) => language.id === id) ?? SOURCE_LANGUAGES[0]!;
}
