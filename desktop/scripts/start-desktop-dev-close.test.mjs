// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('./start-desktop-dev.mjs', import.meta.url));
const scenarios = [
  { name: 'exact-checkout', window: 1, close: true, waitExit: true },
  { name: 'natural-exit', window: 1, close: false, exitOnClose: true },
  { name: 'no-window-exits', window: 0, close: false, waitExit: true },
  { name: 'no-window-pending', window: 0, close: false },
  { name: 'close-not-requested', window: 1, close: false },
  { name: 'requested-exit-pending', window: 1, close: true },
  { name: 'access-denied', window: 1, close: false, denied: true },
];
let results;

beforeAll(() => {
  if (process.platform !== 'win32') return;
  // Execute the actual PowerShell block. Only OS process lookup and returned
  // Process methods are stubbed; no real window, process or token is changed.
  const source = readFileSync(launcher, 'utf8');
  const block = source.match(
    /const check = spawnSync\('powershell\.exe', \['-NoProfile', '-Command', String\.raw`([\s\S]*?)`\], \{/,
  );
  expect(block).not.toBeNull();
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRYLO_CLOSE_CASES)) | ConvertFrom-Json
$closeCode = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRYLO_CLOSE_CODE))
$reports = @()
function Get-CimInstance {
    param([string]$Filter)
    @([pscustomobject]@{ProcessId=42; ExecutablePath=$env:TRYLO_DEV_EXECUTABLE},
      [pscustomobject]@{ProcessId=99; ExecutablePath='C:\unrelated\trylo-desktop.exe'},
      [pscustomobject]@{ProcessId=58252; ExecutablePath='C:\independent\node.exe'})
}
function Get-Process {
    param([int]$Id, [string]$ErrorAction)
    $global:lookedUp.Add($Id)
    if ($Id -ne 42) { throw 'unrelated process lookup' }
    return $global:fakeProcess
}
foreach ($case in $cases) {
    $global:scenario=$case
    $global:closeCalls=New-Object 'System.Collections.Generic.List[int]'
    $global:waitCalls=New-Object 'System.Collections.Generic.List[int]'
    $global:lookedUp=New-Object 'System.Collections.Generic.List[int]'
    $global:fakeProcess=[pscustomobject]@{Id=42; HasExited=$false; MainWindowHandle=[IntPtr]([int]$case.window)}
    $global:fakeProcess | Add-Member ScriptMethod Refresh { }
    $global:fakeProcess | Add-Member ScriptMethod CloseMainWindow {
        $global:closeCalls.Add($this.Id)
        if ($global:scenario.denied) { throw (New-Object ComponentModel.Win32Exception 5) }
        if ($global:scenario.exitOnClose) { $this.HasExited=$true }
        return [bool]$global:scenario.close
    }
    $global:fakeProcess | Add-Member ScriptMethod WaitForExit {
        param([int]$milliseconds)
        $global:waitCalls.Add($milliseconds)
        if ($milliseconds -gt 0 -and $global:scenario.waitExit) { $this.HasExited=$true }
        return $this.HasExited
    }
    $failure=$null
    try { Invoke-Expression $closeCode } catch { $failure=$_.Exception.Message }
    $reports += [pscustomobject]@{name=$case.name; ok=($null -eq $failure); error=$failure;
        closeCalls=@($global:closeCalls.ToArray()); waitCalls=@($global:waitCalls.ToArray()); lookedUp=@($global:lookedUp.ToArray())}
}
ConvertTo-Json -InputObject @($reports) -Compress -Depth 5
`;
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    env: {
      ...process.env,
      TRYLO_DEV_EXECUTABLE: 'C:\current-checkout\desktop\src-tauri\target\debug\trylo-desktop.exe',
      TRYLO_CLOSE_CASES: Buffer.from(JSON.stringify(scenarios)).toString('base64'),
      TRYLO_CLOSE_CODE: Buffer.from(block[1]).toString('base64'),
    },
    encoding: 'utf8',
    windowsHide: true,
  });
  results = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
});

const platformTest = process.platform === 'win32' ? it : it.skip;
const result = (name) => results.find((row) => row.name === name);

platformTest('closes only the exact checkout and preserves other Desktop/central processes', () => {
  expect(result('exact-checkout')).toMatchObject({ ok: true, lookedUp: [42], closeCalls: [42] });
});

platformTest('accepts an independently observed natural exit after close returned false', () => {
  expect(result('natural-exit').ok).toBe(true);
});

platformTest('observes an already closing windowless instance without sending another close', () => {
  expect(result('no-window-exits')).toMatchObject({ ok: true, closeCalls: [] });
  expect(result('no-window-exits').waitCalls).toContain(10000);
});

platformTest('reports a mapped windowless instance separately from an undelivered close', () => {
  expect(result('no-window-pending').error).toContain('[TRYLO_DEV_NO_WINDOW_PENDING]');
  expect(result('no-window-pending').closeCalls).toEqual([]);
  expect(result('close-not-requested').error).toContain('[TRYLO_DEV_CLOSE_NOT_REQUESTED]');
});

platformTest('reports requested-close exit pending without inventing a permission diagnosis', () => {
  expect(result('requested-exit-pending').error).toContain('[TRYLO_DEV_EXIT_PENDING]');
  expect(result('requested-exit-pending').error).not.toMatch(/permission|integrity|elevat/i);
  expect(result('requested-exit-pending').waitCalls).toContain(10000);
});

platformTest('reports an observed Win32 access denial separately', () => {
  expect(result('access-denied').error).toContain('[TRYLO_DEV_CLOSE_ACCESS_DENIED]');
});
