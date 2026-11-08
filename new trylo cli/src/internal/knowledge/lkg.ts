import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionProfileSnapshot } from "../contract/profile.js";
import { canonicalJson, sha256Hex } from "../learning/control/hash.js";

const LKG_FILE = "last-known-good.json";

type LkgFile = {
  readonly checksum: string;
  readonly snapshot: ExecutionProfileSnapshot;
};

export async function saveLastKnownGood(
  rootDir: string,
  snapshot: ExecutionProfileSnapshot,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  const checksum = sha256Hex(canonicalJson(snapshot));
  const body: LkgFile = { checksum, snapshot };
  const target = path.join(rootDir, LKG_FILE);
  const tmp = `${target}.tmp`;

  await writeFile(tmp, `${JSON.stringify(body)}\n`, "utf8");
  await rename(tmp, target);
}

export async function loadLastKnownGood(
  rootDir: string,
): Promise<ExecutionProfileSnapshot | undefined> {
  let raw: string;

  try {
    raw = await readFile(path.join(rootDir, LKG_FILE), "utf8");
  } catch {
    // Every way this file can be unusable — absent, a directory, unreadable —
    // is a cache miss, not a session error: the LKG is derived from the board
    // (the authoritative source) and the next successful write replaces it.
    // A fatal error over a derived file would block a turn the user cannot
    // even ask for help about; the adversarial test
    // "last-known-good write failure does not degrade a successful assemble"
    // is the contract this follows.
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isLkgShape(parsed)) {
    return undefined;
  }

  // Corrupt-and-regenerate is the documented contract for this file — a
  // cache, not history: unlike the session store's fail-closed recovery, an
  // unusable LKG degrades to "absent" and the knowledge layer rebuilds. The
  // checksum authenticates the snapshot bytes: canonicalJson(parsed.snapshot)
  // matches only the exact saved value, so a wrong-shaped or tampered file
  // cannot pass.
  if (sha256Hex(canonicalJson(parsed.snapshot)) !== parsed.checksum) {
    return undefined;
  }

  return parsed.snapshot;
}

function isLkgShape(value: unknown): value is LkgFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.checksum === "string" &&
    typeof record.snapshot === "object" &&
    record.snapshot !== null &&
    !Array.isArray(record.snapshot)
  );
}
