import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let scratchRoot: string | undefined;

/** Repository test scratch, independent of cwd and of a variant build's outDir.
 * Only tests and their fixture builders may import this module. */
export function testScratchPath(...segments: string[]): string {
  if (scratchRoot === undefined) {
    let directory = path.dirname(fileURLToPath(import.meta.url));

    while (!existsSync(path.join(directory, "AGENTS.md")) || !existsSync(path.join(directory, "new trylo cli/package.json"))) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error("Test scratch requires a Trylo repository checkout");
      directory = parent;
    }

    scratchRoot = path.join(directory, "_workspace/tmp/new-cli-tests");
  }

  const target = path.resolve(scratchRoot, ...segments);
  const relative = path.relative(scratchRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Test scratch must stay inside the repository test workspace");
  }

  mkdirSync(scratchRoot, { recursive: true });

  return target;
}
