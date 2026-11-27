import { childEnvironment } from "../../tools/mutating/shell-spawn.js";

/** The trusted broker needs the host ledger; the restricted runner gets only --env overlays. */
export function windowsHelperEnvironment(host: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const localAppData = host.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim().length === 0) {
    throw new Error("isolation_refused: host LOCALAPPDATA is required for the helper permission ledger");
  }
  return { ...childEnvironment({ env: host }), LOCALAPPDATA: localAppData };
}
