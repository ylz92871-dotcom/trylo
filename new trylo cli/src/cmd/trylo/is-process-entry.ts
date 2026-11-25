import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Node resolves a package bin's symlink for imports but preserves argv[1]. */
export function isProcessEntry(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;

  try {
    return realpathSync.native(entry) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    // A missing argv target cannot be the module that Node already loaded.
    return false;
  }
}
