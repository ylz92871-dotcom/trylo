/** Historical shipped placeholders, shared by settings migration and resolution. */
export const LEGACY_RUNTIME_DEFAULT_CLI_PATH = 'C:/trylo-cli/cli.js';

/** Arbitrary custom entries are never classified from their filename. */
export function isLegacyRuntimeDefaultCliPath(path: string): boolean {
  const normalized = path.trim().replaceAll('\\', '/').toLowerCase();
  return normalized === LEGACY_RUNTIME_DEFAULT_CLI_PATH.toLowerCase()
    || normalized === 'd:/cc/trylo/trylo cli/cli.js';
}
