import path from "node:path";
import { mkdir, open, readFile } from "node:fs/promises";
import type { AllocationApplicationInput } from "../../learning/control/allocation-application-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";

/** Immutable original application input, as required by the existing allocator's
 * exact recovery contract. This archive is evidence only: it owns no balance,
 * claim, source readiness, dispatch right or automatic retry state. */
export async function retainCentralSubmission(boardRoot: string, input: AllocationApplicationInput) {
  const payload = canonicalJson({ schemaVersion: 1, type: "central_learning_submission", input });
  const digest = contentHashOf(input), directory = path.join(boardRoot, "central-decisions");
  const file = path.join(directory, `${digest}.json`);

  await mkdir(directory, { recursive: true });
  let handle;

  try { handle = await open(file, "wx"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const previous = await readFile(file, "utf8");
    if (previous !== payload) throw new Error("central_submission_archive_conflict");
    return { digest, file };
  }

  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  }
  finally { await handle.close(); }

  return { digest, file };
}
