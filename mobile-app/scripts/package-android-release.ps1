[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $mobileRoot
$androidRoot = Join-Path $mobileRoot 'android'
$signingRoot = Join-Path $workspaceRoot '.trylo\android-signing'
$keystorePath = Join-Path $signingRoot 'trylo-code-release.p12'
$recoveryPath = Join-Path $signingRoot 'SIGNING-RECOVERY.txt'
$keyAlias = 'trylo-code'

function Assert-LastExitCode([string]$step) {
  if ($LASTEXITCODE -ne 0) {
    throw "$step failed with exit code $LASTEXITCODE."
  }
}

function Get-AndroidStudioJavaHome {
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    return $env:JAVA_HOME
  }
  $studio = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Android Studio' -ErrorAction SilentlyContinue
  if ($studio.Path) {
    $candidate = Join-Path $studio.Path 'jbr'
    if (Test-Path (Join-Path $candidate 'bin\java.exe')) { return $candidate }
  }
  throw 'Android Studio JBR was not found. Set JAVA_HOME to Java 21 and retry.'
}

function Get-AndroidSdkPath {
  if ($env:ANDROID_HOME -and (Test-Path $env:ANDROID_HOME)) { return $env:ANDROID_HOME }
  $propertiesPath = Join-Path $androidRoot 'local.properties'
  $line = Get-Content -Path $propertiesPath | Where-Object { $_ -like 'sdk.dir=*' } | Select-Object -First 1
  if (-not $line) { throw 'sdk.dir is missing from android/local.properties.' }
  return $line.Substring(8).Replace('\:', ':').Replace('\\', '\')
}

function New-RandomPassword {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').TrimEnd('=')
}

$env:JAVA_HOME = Get-AndroidStudioJavaHome
$sdkPath = Get-AndroidSdkPath
$buildTools = Get-ChildItem -Path (Join-Path $sdkPath 'build-tools') -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'apksigner.bat') } |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1
if (-not $buildTools) { throw 'Android SDK build tools were not found.' }

$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
$java = Join-Path $env:JAVA_HOME 'bin\java.exe'
$apksigner = Join-Path $buildTools.FullName 'lib\apksigner.jar'

New-Item -ItemType Directory -Path $signingRoot -Force | Out-Null
if ((Test-Path $keystorePath) -xor (Test-Path $recoveryPath)) {
  throw 'The signing identity is incomplete. Restore both files under .trylo/android-signing before continuing.'
}

if (-not (Test-Path $keystorePath)) {
  $password = New-RandomPassword
  & $keytool -genkeypair -noprompt -storetype PKCS12 -keystore $keystorePath -storepass $password -keypass $password -alias $keyAlias -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10000 -dname 'CN=Trylo Code, O=Trylo, C=CN'
  Assert-LastExitCode 'Release keystore creation'
  $recovery = @(
    'Trylo Code Android release signing identity'
    'KEEP THIS FILE AND THE .p12 KEYSTORE PRIVATE. BACK UP BOTH OFFLINE.'
    "Keystore: $keystorePath"
    "Alias: $keyAlias"
    "Password: $password"
  ) -join [Environment]::NewLine
  [System.IO.File]::WriteAllText($recoveryPath, $recovery, [System.Text.UTF8Encoding]::new($false))
} else {
  $passwordLine = Get-Content -Path $recoveryPath | Where-Object { $_ -like 'Password: *' } | Select-Object -First 1
  if (-not $passwordLine) { throw 'The signing recovery file does not contain a password.' }
  $password = $passwordLine.Substring(10)
}

Push-Location $mobileRoot
try {
  & npm.cmd run build
  Assert-LastExitCode 'Web build'
  & npm.cmd run cap:sync -- android
  Assert-LastExitCode 'Capacitor sync'
} finally {
  Pop-Location
}

Push-Location $androidRoot
try {
  & .\gradlew.bat lintRelease assembleRelease
  Assert-LastExitCode 'Android release build'
} finally {
  Pop-Location
}

$unsignedApk = Join-Path $androidRoot 'app\build\outputs\apk\release\app-release-unsigned.apk'
$appVersion = (Get-Content -Raw -LiteralPath (Join-Path $mobileRoot 'package.json') | ConvertFrom-Json).version
if (-not $appVersion) { throw 'The app version is missing from mobile-app/package.json.' }
$releaseRoot = Join-Path $mobileRoot 'releases'
$apkName = "Trylo-Code-v$appVersion.apk"
$alignedApk = Join-Path $releaseRoot "Trylo-Code-v$appVersion-aligned.apk"
$signedApk = Join-Path $releaseRoot $apkName
$checksumPath = "$signedApk.sha256"
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Remove-Item -LiteralPath $alignedApk -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $signedApk -Force -ErrorAction SilentlyContinue

& $zipalign -f -p 4 $unsignedApk $alignedApk
Assert-LastExitCode 'APK alignment'
$env:TRYLO_SIGNING_PASSWORD = $password
try {
  # Invoke the JAR directly: cmd.exe expands the '%' in this workspace path
  # when apksigner.bat is used, corrupting arguments before they reach Java.
  & $java -jar $apksigner sign --ks $keystorePath --ks-key-alias $keyAlias --ks-pass env:TRYLO_SIGNING_PASSWORD --key-pass env:TRYLO_SIGNING_PASSWORD --out $signedApk $alignedApk
  Assert-LastExitCode 'APK signing'
  & $java -jar $apksigner verify --verbose --print-certs $signedApk
  Assert-LastExitCode 'APK signature verification'
} finally {
  Remove-Item Env:\TRYLO_SIGNING_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $alignedApk -Force -ErrorAction SilentlyContinue
}

$checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $signedApk).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText($checksumPath, "$checksum  $apkName`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Release APK: $signedApk"
Write-Host "SHA-256: $checksum"
Write-Host "Signing backup: $signingRoot"
