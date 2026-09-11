// Trylo Desktop — name filter shared by the dev file API.
//
// Exported separately so it can be unit-tested without
// spinning up Vite. The same set is also used by the
// production-side WorkspaceTree component when it has
// access to a Tauri runtime (callers replicate the list
// in Rust in the future; for now both sides agree on
// "ignore these and any dotfile").
//
// The list comes from the v1.15-handoff spec §2.4:
// "隐藏 `node_modules`、`.git`、`dist` 等".

/** Folders the tree never opens into. */
export const HIDDEN_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.trylo',
  'dist',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.pnpm-store',
  'out',
  'build',
]);

/** True when a name should be skipped by the tree. */
export function isHiddenName(name: string): boolean {
  if (name.startsWith('.')) return true;
  return HIDDEN_DIRS.has(name);
}
