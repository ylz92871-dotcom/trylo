$ErrorActionPreference = 'Stop'
$desktop = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\')
$resources = Join-Path $desktop 'src-tauri\resources\preview\office'
$stage = Join-Path $PSScriptRoot 'stage-office-engine.mjs'

# A verified supplied tree needs no installed Office or extraction cache.
if (Test-Path -LiteralPath $resources) {
    node $stage --check
    if ($LASTEXITCODE -ne 0) {
        # Only the exact upstream full inventory can be migrated automatically.
        node $stage --from-staged-full
        if ($LASTEXITCODE -ne 0) { throw 'Preserve and inspect the invalid staged Office engine before replacing it.' }
    }
    return
}
if ($env:TRYLO_OFFICE_ENGINE_DIR) {
    node $stage --source $env:TRYLO_OFFICE_ENGINE_DIR
    if ($LASTEXITCODE -ne 0) { throw 'Explicit Office engine source failed verification.' }
    return
}
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'office-engine.lock.json') -Raw | ConvertFrom-Json
$previewCache = [IO.Path]::GetFullPath((Join-Path $desktop '../_workspace/cache/desktop/preview/office'))
$cache = Join-Path $previewCache $lock.version
node (Join-Path $PSScriptRoot 'download-office-engine.mjs') --output $cache
if ($LASTEXITCODE -ne 0) { throw 'Pinned Office MSI supply failed.' }
$msi = Join-Path $cache ([IO.Path]::GetFileName(([Uri]$lock.sourceUrl).AbsolutePath))
$extracted = Join-Path $cache 'extracted'
if (-not (Test-Path -LiteralPath $extracted)) {
    # /a extracts an administrative image; /qn performs no UI or system
    # installation. Existing user Office associations/profiles are untouched.
    $extractionLog = Join-Path $cache 'extract.log'
    $arguments = @('/a', ('"' + $msi + '"'), '/qn', '/norestart', ('TARGETDIR="' + $extracted + '"'), '/L*v', ('"' + $extractionLog + '"'))
    $extraction = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($extraction.ExitCode -ne 0) { throw "Office extraction failed ($($extraction.ExitCode)); retain its log and partial output." }
}
$identity = Join-Path $extracted 'program\version.ini'
if (-not (Test-Path -LiteralPath $identity) -or -not ((Get-Content -LiteralPath $identity -Raw).Contains('buildid=' + $lock.buildId))) {
    throw 'Retain and inspect the incomplete extraction; it does not match the release lock.'
}
node $stage --source $extracted
if ($LASTEXITCODE -ne 0) { throw 'Extracted Office engine failed full staging verification.' }
