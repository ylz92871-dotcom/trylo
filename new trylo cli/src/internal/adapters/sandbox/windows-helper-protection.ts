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
  # Add-Type invokes CodeDOM's temporary compiler directory creation, which can
  # require privileges a normal Medium caller does not hold. These fixed Win32
  # signatures need no compiler, file-backed assembly or privilege elevation.
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('TryloIntegrityLabel'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('Native')
  $builder = $module.DefineType('TryloIntegrityLabel', 'Public, Abstract, Sealed')
  $pointer = [IntPtr].MakeByRefType()
  $unsigned = [uint32].MakeByRefType()
  function Add-NativeMethod($name, $library, $result, [Type[]]$parameters) {
    $method = $builder.DefinePInvokeMethod($name, $library, 'Public, Static, PinvokeImpl',
      'Standard', $result, $parameters, 'Winapi', 'Unicode')
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  }
  Add-NativeMethod 'GetNamedSecurityInfo' ($env:SystemRoot + '\System32\advapi32.dll') ([uint32]) @([string], [int], [uint32], $pointer, $pointer, $pointer, $pointer, $pointer)
  Add-NativeMethod 'ConvertSecurityDescriptorToStringSecurityDescriptor' ($env:SystemRoot + '\System32\advapi32.dll') ([bool]) @([IntPtr], [uint32], [uint32], $pointer, $unsigned)
  Add-NativeMethod 'LocalFree' ($env:SystemRoot + '\System32\kernel32.dll') ([IntPtr]) @([IntPtr])
  $native = $builder.CreateType()
  $owner = $group = $dacl = $sacl = $descriptor = [IntPtr]::Zero
  $status = $native::GetNamedSecurityInfo($path, 1, 0x10, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$descriptor)
  if ($status -ne 0) { throw [ComponentModel.Win32Exception]::new([int]$status) }
  try {
    $text = [IntPtr]::Zero
    $length = [uint32]0
    if (-not $native::ConvertSecurityDescriptorToStringSecurityDescriptor($descriptor, 1, 0x10, [ref]$text, [ref]$length)) {
      throw 'native cache integrity label could not be read'
    }
    try { $integrity = [Runtime.InteropServices.Marshal]::PtrToStringUni($text) }
    finally { $null = $native::LocalFree($text) }
  } finally { $null = $native::LocalFree($descriptor) }
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
