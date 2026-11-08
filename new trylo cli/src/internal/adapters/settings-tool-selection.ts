import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createSettingsLoader } from "./settings-fs.js";
import { parseLayerContent } from "../settings/parse.js";
import { validateSettingsObject } from "../settings/schema.js";
import { writeFileAtomicallySync } from "./tools/mutating/atomic-write.js";
import type { LibraryResult } from "../tooling/library/index.js";

const failure = (code: string, message: string) => ({ ok: false as const, code, message });
const read = (file: string): string | undefined => {
  try { return readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Writes the original project settings file; the settings loader remains the only merge/schema owner. */
export function createProjectToolSelection(options: { readonly workspaceRoot: string; readonly profileRoot: string }) {
  const target = path.join(options.workspaceRoot, ".trylo", "config.json");
  return {
    read(): LibraryResult<readonly string[] | undefined> {
      try {
        const loaded = createSettingsLoader({ readFile: read }).load({ homeDir: options.profileRoot, workspaceDir: options.workspaceRoot });
        if (!loaded.ok) return failure(loaded.code, loaded.detail);
        const selection = loaded.value.toolSelection?.value;
        return { ok: true, value: Array.isArray(selection) ? selection as readonly string[] : undefined };
      } catch { return failure("configuration_read_failed", "The original tool selection settings could not be read"); }
    },
    write(names: readonly string[]): LibraryResult<void> {
      const valid = validateSettingsObject({ toolSelection: [...names] }, target);
      if (!valid.ok) return failure(valid.code, valid.detail);

      let lock: number | undefined;

      try {
        mkdirSync(path.dirname(target), { recursive: true });

        try { lock = openSync(`${target}.lock`, "wx"); }
        catch { return failure("configuration_busy", "Another settings writer owns the project configuration; retry after it finishes"); }

        const current = read(target), parsed = parseLayerContent(current === undefined ? { status: "missing" } : { status: "present", raw: current }, target);
        if (!parsed.ok) return failure(parsed.code, parsed.detail);

        writeFileAtomicallySync(target, `${JSON.stringify({ formatVersion: 1, ...parsed.values, toolSelection: names }, null, 2)}\n`);

        return { ok: true, value: undefined };
      } catch { return failure("configuration_write_failed", "The original project tool selection was not saved"); }
      finally { if (lock !== undefined) {
        closeSync(lock);
        unlinkSync(`${target}.lock`);
      } }
    },
  };
}
