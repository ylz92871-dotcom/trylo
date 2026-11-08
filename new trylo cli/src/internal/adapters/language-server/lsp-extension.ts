/**
 * File extension to language id, in one table.
 *
 * Duplicated in every language server ecosystem, and duplicated badly — a table
 * with a fallback is better than a table that guesses. `languageId` matters to
 * the server, not to us: sending `typescriptreact` for a `.tsx` file is what
 * makes a server parse it as TSX instead of choking on the JSX.
 *
 * An unmapped extension returns `undefined` rather than a default. The caller
 * then reports `lsp_not_configured`, which is a true statement, where a default
 * would produce a server that accepts the file and answers nonsense about it.
 */

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  swift: "swift",
  m: "objective-c",
  mm: "objective-cpp",
  lua: "lua",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
};

/** Lower-case extension without the dot, or `undefined` when there is none. */
export function extensionOf(path: string): string | undefined {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");

  // A leading dot means a dotfile (`.gitignore`), not an extension. Without this
  // check every dotfile in a project would route to whatever owns "".
  if (dot <= 0 || dot === name.length - 1) {
    return undefined;
  }

  return name.slice(dot + 1).toLowerCase();
}

export function languageIdOf(path: string): string | undefined {
  const extension = extensionOf(path);
  return extension === undefined ? undefined : LANGUAGE_BY_EXTENSION[extension];
}
