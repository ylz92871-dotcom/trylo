# Trylo Work M7 cleanup: kill every trylo-workd / coworkd process.
# Allowlist only — never touches unrelated node.exe.
# Run as: powershell -ExecutionPolicy Bypass -File cleanup.ps1
#
# After this:
#   - 47821 should have no listener
#   - no node process should be running trylo-workd / coworkd-node / main.js
#
# This is the precondition for the fresh-start baseline (D).

$ErrorActionPreference = "Continue"

$matches = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" `
  | Where-Object {
      $cl = $_.CommandLine
      if ($null -eq $cl) { return $false }
      return ($cl -like "*trylo-workd*") -or
             ($cl -like "*coworkd*")     -or
             ($cl -like "*cowork-os*")
    }

Write-Output "=== Pre-kill snapshot ==="
foreach ($p in $matches) {
  Write-Output ("PID {0,6}  {1}" -f $p.ProcessId, $p.CommandLine)
}

$killed = @()
$failed = @()
foreach ($p in $matches) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    $killed += $p.ProcessId
  } catch {
    $failed += [PSCustomObject]@{ PID = $p.ProcessId; Error = $_.Exception.Message }
  }
}

# Give the OS a moment to release the port.
Start-Sleep -Milliseconds 500

Write-Output ""
Write-Output "=== Post-kill ==="
Write-Output ("Killed: {0}" -f ($killed -join ", "))
if ($failed.Count -gt 0) {
  Write-Output "Failed:"
  foreach ($f in $failed) { Write-Output ("  PID {0}: {1}" -f $f.PID, $f.Error) }
}

Write-Output ""
Write-Output "=== Remaining trylo-workd processes ==="
$remaining = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" `
  | Where-Object {
      $cl = $_.CommandLine
      if ($null -eq $cl) { return $false }
      return ($cl -like "*trylo-workd*") -or ($cl -like "*coworkd*")
    }
if ($remaining.Count -eq 0) {
  Write-Output "  (none)"
} else {
  foreach ($p in $remaining) { Write-Output ("  PID {0,6}  {1}" -f $p.ProcessId, $p.CommandLine) }
}

Write-Output ""
Write-Output "=== 47821 listeners (should be empty) ==="
$conn = Get-NetTCPConnection -LocalPort 47821 -ErrorAction SilentlyContinue
if ($null -eq $conn) {
  Write-Output "  (no connection records — port is free)"
} else {
  $conn | Select-Object State, OwningProcess | Format-Table -AutoSize
}
