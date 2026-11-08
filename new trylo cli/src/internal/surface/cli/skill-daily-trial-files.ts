import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { workspaceFile } from "./skill-daily-checks.js";

export function replayFileDigest(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

const MAX_REPLAY_INPUT_BYTES = 1_048_576;

/** A stat is only an early rejection; the bounded read also handles concurrent growth. */
async function boundedInputDigest(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REPLAY_INPUT_BYTES) return undefined;

    const hash = createHash("sha256"), buffer = Buffer.alloc(65_536);
    let total = 0;

    for (;;) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, MAX_REPLAY_INPUT_BYTES + 1 - total), null);
      if (result.bytesRead === 0) return hash.digest("hex");
      total += result.bytesRead;
      if (total > MAX_REPLAY_INPUT_BYTES) return undefined;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
  } finally { await handle.close(); }
}

/** Initial replay inputs are immutable; missing/replaced/escaped files fail closed. */
export async function replayInputsUnchanged(workspace: string, initialHashes: Readonly<Record<string, string>>): Promise<boolean> {
  try {
    const root = await realpath(workspace);

    for (const [relative, expected] of Object.entries(initialHashes)) {
      const file = await realpath(workspaceFile(workspace, relative));
      const inside = path.relative(root, file);
      if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return false;
      if (await boundedInputDigest(file) !== expected) return false;
    }

    return true;
  } catch {
    // Read/identity failures mean the original input is no longer established.
    return false;
  }
}
