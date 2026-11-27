param([Parameter(Mandatory = $true)][string]$ProjectDirectory,
      [Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$assets = Get-Content -LiteralPath (Join-Path $ProjectDirectory 'obj/project.assets.json') -Raw | ConvertFrom-Json
$runtimePath = Join-Path $ProjectDirectory 'bin/Release/net8.0-windows10.0.19041.0/win-x64/trylo-wgc-helper.runtimeconfig.json'
$runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
foreach ($framework in $runtime.runtimeOptions.includedFrameworks) {
    $name = $framework.name.ToLowerInvariant() + '.runtime.win-x64'
    $pack = $null
    foreach ($folder in $assets.packageFolders.PSObject.Properties.Name) {
        $candidate = Join-Path $folder "$name/$($framework.version)"
        if (Test-Path -LiteralPath $candidate) { $pack = $candidate; break }
    }
    if (-not $pack) { throw "Missing WGC runtime notice input: $name $($framework.version)" }
    $licensed = $false
    foreach ($file in @('LICENSE', 'LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT')) {
        $source = Join-Path $pack $file
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $Destination "$($framework.name)-$file") -Force
            if ($file -like 'LICENSE*') { $licensed = $true }
        }
    }
    if (-not $licensed) { throw 'WGC runtime license missing.' }
}
