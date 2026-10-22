import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { windowsHelperEnvironment } from "./windows-helper-environment.js";
import { ShellIsolationError } from "../../ports/isolation.js";

export type CacheTarget = {
  readonly kind: "directory" | "executable";
  readonly path: string;
  readonly state: "new" | "existing";
};

// The directory is private and protected. Files inherit its temporary SRT read
// grants, but no untrusted principal may write, delete or change their DACL.
const PROTECT_CACHE = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:TRYLO_NATIVE_TARGET
$kind = $env:TRYLO_NATIVE_KIND
$state = $env:TRYLO_NATIVE_STATE
if ((Get-Item -LiteralPath $path -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
  throw 'native cache target is redirected'
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$writers = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($state -eq 'new') {
  $acl = if ($kind -eq 'directory') {
    New-Object System.Security.AccessControl.DirectorySecurity
  } else {
    New-Object System.Security.AccessControl.FileSecurity
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($identity in $writers) {
    $principal = [System.Security.Principal.SecurityIdentifier]::new($identity)
    $rule = if ($kind -eq 'directory') {
      New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
      New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'Allow')
    }
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}
$acl = Get-Acl -LiteralPath $path
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -notin $writers) { throw 'native cache has an untrusted owner' }
# Write data, append, write EA/attributes, delete child/object, WRITE_DAC/OWNER.
$writeMask = 0x000d0156
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $writers -and (([int]$rule.FileSystemRights -band $writeMask) -ne 0)) {
    throw 'native cache is writable by another identity'
  }
}
if ($kind -eq 'executable') {
  if ($acl.AreAccessRulesProtected) {
    $acl.SetAccessRuleProtection($false, $true)
    Set-Acl -LiteralPath $path -AclObject $acl
  }
  $icacls = $env:SystemRoot + '\System32\icacls.exe'
  # Query LABEL_SECURITY_INFORMATION directly. Mandatory SIDs cannot reliably
  # be translated through account lookup, and icacls display names are localized.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TryloIntegrityLabel {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
  static extern uint GetNamedSecurityInfo(string name, int kind, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string Read(string path) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint status = GetNamedSecurityInfo(path, 1, 0x10, out owner, out group, out dacl, out sacl, out descriptor);
    if (status != 0) throw new Win32Exception((int)status);
    try {
      IntPtr text; uint length;
      if (!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 0x10, out text, out length)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
    } finally { LocalFree(descriptor); }
  }
}
'@
  $integrity = [TryloIntegrityLabel]::Read($path)
  # Cached helpers are often already in use. Reapplying an unchanged SACL
  # can be refused even though its required medium/no-write-up label is valid.
  if ($integrity -notmatch '^S:(?:AI|AR|P)*\(ML;;NW;;;ME\)$') {
    & $icacls $path /setintegritylevel M | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'private helper integrity label could not be set' }
  }
}
`;

export function protectWindowsCacheTarget(target: CacheTarget, env: Readonly<Record<string, string | undefined>>): void {
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"];
  if (systemRoot === undefined) throw new Error("isolation_helper_invalid: SystemRoot is missing");
  try {
    execFileSync(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", PROTECT_CACHE], {
      env: { ...windowsHelperEnvironment(env), TRYLO_NATIVE_TARGET: target.path, TRYLO_NATIVE_KIND: target.kind, TRYLO_NATIVE_STATE: target.state },
      windowsHide: true, encoding: "utf8", timeout: 30000,
    });
  } catch (cause) {
    // execFile's message embeds the entire trusted PowerShell/C# program.
    // Preserve the OS diagnostic and causal error, not a script-sized prompt.
    const stderr: unknown = cause !== null && typeof cause === "object" ? Reflect.get(cause, "stderr") : undefined;
    const diagnostic = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "helper protection process failed";
    throw new ShellIsolationError("isolation_helper_protection_failed",
      `private helper protection failed; no command was run. ${diagnostic.trim().slice(-1_500)}`, { cause });
  }
}
