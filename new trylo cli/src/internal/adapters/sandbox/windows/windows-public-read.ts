import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { hostProcessEnvironment } from "../executable.js";

type AccessRule = { readonly sid: string; readonly mask: number; readonly deny: boolean; readonly inheritOnly: boolean };

const COMMON = new Set(["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]);
const READ_EXECUTE = 0x1200a9;

/** Conservative optimization only: the restricted logon's kernel check is final. */
export function hasCommonReadExecute(rules: readonly AccessRule[]): boolean {
  // Unknown group membership may make any deny relevant. Never guess through it.
  if (rules.some(rule => rule.deny && !rule.inheritOnly)) return false;
  const allowed = rules.filter(rule => !rule.inheritOnly && COMMON.has(rule.sid)).reduce((mask, rule) => mask | rule.mask, 0);
  return (allowed & READ_EXECUTE) === READ_EXECUTE;
}

/** Read existing ACLs; do not try to add an ACE to protected system directories. */
export function hasPublicExecutableRead(program: string): boolean {
  const env = { ...hostProcessEnvironment() };
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"];
  if (systemRoot === undefined) return false;

  // Windows PowerShell 5 cannot load a PowerShell 7 module path inherited by a host.
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PSMODULEPATH") delete env[key];

  const paths = [program, dirname(program)].map(path => `'${path.replaceAll("'", "''")}'`).join(",");
  const script = `$ErrorActionPreference='Stop'; @(${paths}) | ForEach-Object { $rules=(Get-Acl -LiteralPath $_).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); @($rules | ForEach-Object { @{sid=$_.IdentityReference.Value; mask=[int]$_.FileSystemRights; deny=($_.AccessControlType -eq 'Deny'); inheritOnly=(($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)} }) | ConvertTo-Json -Compress; }`;

  try {
    const output = execFileSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env, encoding: "utf8", windowsHide: true, timeout: 10000 });
    const rows = output.trim().split(/\r?\n/).map(line => JSON.parse(line) as unknown);
    return rows.length === 2 && rows.every(row => {
      const rules = Array.isArray(row) ? row : [row];
      return rules.every(isRule) && hasCommonReadExecute(rules);
    });
  } catch {
    // A failed observation supplies no proof to skip the ordinary read grant.
    return false;
  }
}

function isRule(value: unknown): value is AccessRule {
  if (value === null || typeof value !== "object") return false;
  return "sid" in value && typeof value.sid === "string" && "mask" in value && typeof value.mask === "number" && "deny" in value && typeof value.deny === "boolean" && "inheritOnly" in value && typeof value.inheritOnly === "boolean";
}
