/**
 * The environment a child process is allowed to see.
 *
 * This is a *base*, not a filter applied afterwards: an entry can add keys
 * (with `env` in the registry) but nothing here lets one reach the parent's
 * full environment. A credential that lives in Trylo's own process therefore
 * cannot leak into an MCP server merely because Trylo happened to start it.
 *
 * It lives apart from the transport so the whitelist can be read — and tested —
 * without a spawned process in sight.
 */

const INHERITED_ENVIRONMENT = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
];

export function childEnvironment(extra: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const key of INHERITED_ENVIRONMENT) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }

  return env;
}
