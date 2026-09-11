# Trylo Work daemon/orphan inventory.
# Lists every node.exe whose command line mentions trylo-workd / coworkd / workd.
# This is the safe allowlist for M7 cleanup. We will NOT touch node
# processes whose command line does not match.

$ErrorActionPreference = "Continue"

$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" `
  | Where-Object {
      $cl = $_.CommandLine
      if ($null -eq $cl) { return $false }
      return ($cl -like "*trylo-workd*") -or
             ($cl -like "*coworkd*")     -or
             ($cl -like "*workd*")       -or
             ($cl -like "*trylo*work*")
    }

Write-Output "=== trylo-workd / coworkd processes ==="
foreach ($p in $procs) {
  $pidLocal = $p.ProcessId
  Write-Output ("PID {0,6}  StartTime={1}  Cmd={2}" -f $pidLocal, $p.CreationDate, $p.CommandLine)
}

Write-Output ""
Write-Output "=== 47821 listeners ==="
Get-NetTCPConnection -LocalPort 47821 -ErrorAction SilentlyContinue `
  | Select-Object State, OwningProcess `
  | Format-Table -AutoSize

Write-Output ""
Write-Output ("Total matched: {0}" -f $procs.Count)
