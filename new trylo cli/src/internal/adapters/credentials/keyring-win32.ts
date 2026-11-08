import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import {
  KEYRING_BLOB_MAX_BYTES,
  KEYRING_PROBE_TARGET,
  type KeyringAvailability,
  type OsKeyringDriver,
} from "../../credentials/keyring-driver.js";

/**
 * The Windows Credential Manager driver (WP 三轨 T3 §5: Windows 侧必须落到
 * Credential Manager)。
 *
 * Implementation without a new dependency (WP §2: 禁新依赖 — a native module
 * such as `keytar` would stop this track `BLOCKED_FOR_ARCHITECTURE`): one
 * `powershell.exe` child per operation, running a *static* script through
 * `-EncodedCommand` that P/Invokes `advapi32!CredRead/CredWrite/CredDelete`
 * (generic credentials, `CRED_PERSIST_LOCAL_MACHINE`).
 *
 * Secret hygiene (acceptance #2):
 *
 *  - the script text is a constant — **argv never contains a secret**;
 *  - the request (operation, target, base64 blob) travels on the child's
 *    **stdin**, which does not appear in process command lines;
 *  - error messages name operation, target and OS error code — never content.
 *
 * Failure mapping, so a caller can tell unavailability (this machine has no
 * keyring) apart from an operation that failed:
 *
 *  - `probe` runs the whole stack once (Add-Type + a read of the probe target)
 *    and reports a *value*, memoized for the process — that is what lets the
 *    prefer-keyring selection degrade to the file ledger + warning instead of
 *    misclassifying a locked-down machine as usable;
 *  - `read`/`write`/`remove` throw on any failure; a missing entry is not a
 *    failure (`ERROR_NOT_FOUND` → `undefined`), copying codex's
 *    `NoEntry => Ok(None)` normalization (D6 §5).
 */

/** The slice of a child result the driver consumes; stdout arrives as UTF-8 text. */
export type SpawnResult = {
  readonly status: number | null;
  readonly error?: Error | undefined;
  readonly stdout: string;
};

/** The child process runner; injectable so a test can spy on argv. */
export type SpawnSyncImpl = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnResult;

function defaultSpawn(command: string, args: readonly string[], options: SpawnSyncOptions): SpawnResult {
  // No `encoding` option: node returns Buffers, decoded here exactly once.
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
    stdout: result.stdout.toString("utf8"),
  };
}

export type WindowsKeyringDriverOptions = {
  /** Defaults to `spawnSync` from `node:child_process`. */
  readonly spawnImpl?: SpawnSyncImpl | undefined;
  /** Defaults to `powershell.exe`. */
  readonly command?: string | undefined;
  /** Whole-child timeout in ms; defaults to 15s. */
  readonly timeoutMs?: number | undefined;
};

type DriverRequest = {
  readonly op: "read" | "write" | "delete";
  readonly target: string;
  readonly blob?: string | undefined;
};

type DriverResponse =
  | { readonly ok: true; readonly found: boolean; readonly blob: string }
  | { readonly ok: false; readonly error: string };

/** What `run` returns once every not-ok branch has already thrown. */
type DriverSuccess = {
  readonly ok: true;
  readonly found: boolean;
  readonly blob: string;
};

/**
 * The static payload script. No interpolation anywhere: the same bytes run for
 * every operation of every process, which is what makes the argv argument
 * checkable (`argv` = [flags, base64 of *this* constant] and nothing else).
 */
const DRIVER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$signature = @'
using System;
using System.Runtime.InteropServices;
public static class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credPtr);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredWrite(ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) {
      int err = Marshal.GetLastWin32Error();
      if (err == 1168) { return ""; }
      throw new Exception("CredRead failed with Win32 error " + err.ToString());
    }
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      byte[] blob = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, blob, 0, blob.Length);
      return Convert.ToBase64String(blob);
    } finally { CredFree(ptr); }
  }
  public static void Write(string target, string blobBase64) {
    byte[] blob = Convert.FromBase64String(blobBase64);
    IntPtr ptr = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, ptr, blob.Length);
      CREDENTIAL cred = new CREDENTIAL();
      cred.Type = 1;
      cred.TargetName = target;
      cred.Comment = "trylo credential ledger";
      cred.CredentialBlobSize = (uint)blob.Length;
      cred.CredentialBlob = ptr;
      cred.Persist = 2;
      cred.UserName = "trylo";
      if (!CredWrite(ref cred, 0)) {
        throw new Exception("CredWrite failed with Win32 error " + Marshal.GetLastWin32Error().ToString());
      }
    } finally { Marshal.FreeHGlobal(ptr); }
  }
  public static void Delete(string target) {
    if (!CredDelete(target, 1, 0)) {
      int err = Marshal.GetLastWin32Error();
      if (err == 1168) { return; }
      throw new Exception("CredDelete failed with Win32 error " + err.ToString());
    }
  }
}
'@
Add-Type -TypeDefinition $signature
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $found = $false
  $blob = ""
  if ($req.op -eq 'read') {
    $blob = [CredMan]::Read($req.target)
    $found = ($blob.Length -gt 0)
  } elseif ($req.op -eq 'write') {
    [CredMan]::Write($req.target, $req.blob)
  } elseif ($req.op -eq 'delete') {
    [CredMan]::Delete($req.target)
  } else {
    throw "unknown op"
  }
  @{ ok = $true; found = $found; blob = $blob } | ConvertTo-Json -Compress | Write-Output
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress | Write-Output
}
`.trim() + "\n";

const ENCODED_SCRIPT = Buffer.from(DRIVER_SCRIPT, "utf16le").toString("base64");

export function createWindowsCredentialManagerDriver(
  options: WindowsKeyringDriverOptions = {},
): OsKeyringDriver {
  const spawn = options.spawnImpl ?? defaultSpawn;
  const command = options.command ?? "powershell.exe";
  const timeoutMs = options.timeoutMs ?? 15_000;
  let memo: KeyringAvailability | undefined;

  return {
    id: "win32-credential-manager",
    probe: (): KeyringAvailability => {
      if (memo === undefined) {
        memo = probeOnce(spawn, command, timeoutMs);
      }
      return memo;
    },
    read: (target) => readOnce(spawn, command, timeoutMs, target),
    write: (target, blob) => writeOnce(spawn, command, timeoutMs, target, blob),
    remove: (target) => removeOnce(spawn, command, timeoutMs, target),
  };
}

function run(
  spawn: SpawnSyncImpl,
  command: string,
  timeoutMs: number,
  request: DriverRequest,
): DriverSuccess {
  // The request (op, target, base64 blob) goes on the child's stdin — never on
  // argv, which is observable by every process on the machine (acceptance #2).
  // The authoritative size cap is enforced by `writeOnce` on the UTF-8 byte
  // count; read/delete payloads are tiny by construction.
  const payload = JSON.stringify({
    op: request.op,
    target: request.target,
    ...(request.blob === undefined ? {} : { blob: encodeBase64(request.blob) }),
  });
  const result = spawn(command, ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPT], {
    // stdin as UTF-8 text (the payload is pure ASCII: op, target, base64 blob);
    // stdout is decoded to UTF-8 text by the spawn wrapper, and the script pins
    // the same encoding on its side.
    input: payload,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`keyring backend could not run (${command}): ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`keyring backend exited with status ${String(result.status)}`);
  }

  const parsed = parseResponse(result.stdout);
  if (!parsed.ok) {
    throw new Error(`keyring backend reported: ${parsed.error}`);
  }

  return parsed;
}

function parseResponse(stdout: string): DriverResponse {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new Error("keyring backend produced no output");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("keyring backend produced unreadable output");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("keyring backend produced an unexpected response shape");
  }

  const record = parsed as Record<string, unknown>;
  if (record["ok"] !== true) {
    return { ok: false, error: typeof record["error"] === "string" ? record["error"] : "unknown error" };
  }

  const found = record["found"] === true;
  const blob = typeof record["blob"] === "string" ? record["blob"] : "";
  if (found && blob.length === 0) {
    throw new Error("keyring backend claimed a blob but sent none");
  }

  return { ok: true, found, blob };
}

function probeOnce(
  spawn: SpawnSyncImpl,
  command: string,
  timeoutMs: number,
): KeyringAvailability {
  try {
    // A read of the fixed probe target exercises Add-Type, P/Invoke and
    // CredRead end to end; "not found" is a *success* here.
    run(spawn, command, timeoutMs, { op: "read", target: KEYRING_PROBE_TARGET });
    return { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : "unknown probe failure" };
  }
}

function readOnce(
  spawn: SpawnSyncImpl,
  command: string,
  timeoutMs: number,
  target: string,
): string | undefined {
  const response = run(spawn, command, timeoutMs, { op: "read", target });
  return response.found ? decodeBase64(response.blob) : undefined;
}

function writeOnce(
  spawn: SpawnSyncImpl,
  command: string,
  timeoutMs: number,
  target: string,
  blob: string,
): void {
  const bytes = Buffer.from(blob, "utf8");
  if (bytes.length > KEYRING_BLOB_MAX_BYTES) {
    throw new Error(
      `credential document is ${String(bytes.length)} bytes; the Windows Credential Manager blob limit is ${String(KEYRING_BLOB_MAX_BYTES)}`,
    );
  }

  run(spawn, command, timeoutMs, { op: "write", target, blob });
}

function removeOnce(
  spawn: SpawnSyncImpl,
  command: string,
  timeoutMs: number,
  target: string,
): void {
  run(spawn, command, timeoutMs, { op: "delete", target });
}

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function decodeBase64(blob: string): string {
  return Buffer.from(blob, "base64").toString("utf8");
}
