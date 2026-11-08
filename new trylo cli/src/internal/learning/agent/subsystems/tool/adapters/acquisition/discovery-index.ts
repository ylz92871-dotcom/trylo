import { readFile } from "node:fs/promises";
import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import type { ToolCandidate } from "../../../../../../tooling/contract/types.js";

export async function loadDiscoveryIndex(
  filePath: string,
): Promise<Result<readonly ToolCandidate[], "discovery_failed">> {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return err("discovery_failed", "discovery index missing");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return err("discovery_failed", "discovery index is not JSON");
  }

  if (typeof parsed !== "object" || parsed === null || !("candidates" in parsed)) {
    return err("discovery_failed", "discovery index missing candidates");
  }

  const candidates = (parsed as { candidates: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return err("discovery_failed", "discovery index candidates must be an array");
  }

  return ok(candidates as ToolCandidate[]);
}

