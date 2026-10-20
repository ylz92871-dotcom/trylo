/**
 * Resolving the run's shell once, at the turn boundary (WP05 C06/C07).
 *
 * The roles precedent applies: like role discovery, the shell is resolved
 * when the turn is prepared and frozen for the turn, so editing the setting
 * takes effect on the next run with nothing to clear. The two stages stay
 * separate — `readShellSetting` answers "was one asked for", `resolveShellMode`
 * answers "which one" — because collapsing them would resolve the platform
 * shell for an absent setting and silently change every flag-off run.
 */

import { readShellSetting, resolveShellMode, type ShellModeResult } from "../../adapters/sandbox/shell-mode.js";
import type { ShellEnvironment } from "../../adapters/sandbox/shell-detect.js";

export function shellModeFor(requested: unknown, surface: ShellEnvironment): ShellModeResult {
  if (requested === "auto") return resolveShellMode(surface, undefined);
  if (requested === "none") return { ok: true, mode: { kind: "none" } };
  const kind = readShellSetting(requested);
  if (kind === undefined) {
    return { ok: true, mode: { kind: "none" } };
  }
  if (kind === null) {
    return {
      ok: false,
      code: "unknown_shell_kind",
      message: `shell setting names no known shell: ${JSON.stringify(requested)}`,
    };
  }
  return resolveShellMode(surface, kind);
}
