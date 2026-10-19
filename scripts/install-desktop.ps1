# Install / uninstall dsh-easy-sync in the Electron-managed desktop profile.
#
# The Electron app owns `$DSH_HOME/profiles/desktop`, and `dsh plugin --profile
# desktop` refuses to manage it. This script performs the same three edits a
# bundle install would make, with a package.json backup:
#   1. junction <profile>/node_modules/dsh-easy-sync -> this repository
#   2. add the dependency to <profile>/package.json
#   3. append the bundle to dsh.profile.bundles
#
# Fully quit the DeepSeek Harness desktop app before running this script.

[CmdletBinding()]
param(
    [string]$RepoPath = '',
    [string]$ProfileDir,
    [switch]$Remove,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# `$PSScriptRoot` is unavailable while parameter defaults bind under Windows
# PowerShell 5.1, so the fallback is resolved after the param block.
if (-not $RepoPath -or $RepoPath.Trim() -eq '') {
    $RepoPath = Split-Path -Parent $PSScriptRoot
}
$RepoPath = [System.IO.Path]::GetFullPath($RepoPath)

$packageName = 'dsh-easy-sync'

function Get-DshHome {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return $env:DSH_HOME.Trim() }
    return (Join-Path $env:USERPROFILE '.dsh')
}

if (-not $ProfileDir -or $ProfileDir.Trim() -eq '') {
    $ProfileDir = Join-Path (Get-DshHome) 'profiles\desktop'
}
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)
$manifestPath = Join-Path $ProfileDir 'package.json'
$modulesDir = Join-Path $ProfileDir 'node_modules'
$linkPath = Join-Path $modulesDir $packageName

Write-Host "dsh-easy-sync installer" -ForegroundColor Cyan
Write-Host "  repository : $RepoPath"
Write-Host "  profile    : $ProfileDir"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "desktop profile manifest not found: $manifestPath (has the desktop app been started at least once?)"
}

$app = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($null -ne $app -and -not $Force) {
    throw "DeepSeek Harness is running. Fully quit it first (or pass -Force if you know what you are doing)."
}

$repoManifest = Join-Path ([System.IO.Path]::GetFullPath($RepoPath)) 'package.json'
if (-not (Test-Path -LiteralPath $repoManifest)) {
    throw "plugin package.json not found: $repoManifest"
}
$repoPackage = Get-Content -LiteralPath $repoManifest -Raw | ConvertFrom-Json
if ($repoPackage.name -ne $packageName) {
    throw "unexpected package name in ${repoManifest}: $($repoPackage.name)"
}

function Read-JsonUtf8([string]$Path) {
    return (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json
}

function Write-JsonUtf8([string]$Path, $Object) {
    $json = $Object | ConvertTo-Json -Depth 16
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json + "`n", $encoding)
}

# ConvertFrom-Json yields PSCustomObject: assigning a property the manifest does
# not already carry throws, so absent fields are added first.
function Set-OrAddProperty($Object, [string]$Name, $Value) {
    if ($null -eq $Object.PSObject.Properties[$Name]) {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    }
    else {
        $Object.$Name = $Value
    }
}

$manifest = Read-JsonUtf8 $manifestPath
if ($null -eq $manifest.dsh -or $null -eq $manifest.dsh.profile) {
    throw "profile manifest has no dsh.profile section: $manifestPath"
}

# Ensure collection types survive ConvertFrom-Json / PSCustomObject handling.
$dependencies = [ordered]@{}
if ($null -ne $manifest.dependencies) {
    foreach ($property in $manifest.dependencies.PSObject.Properties) { $dependencies[$property.Name] = $property.Value }
}
$bundles = @()
if ($null -ne $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }

function New-BackupPath([string]$Path) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $candidate = "$Path.dsh-easy-sync.bak-$stamp"
    $index = 1
    while (Test-Path -LiteralPath $candidate) {
        $candidate = "$Path.dsh-easy-sync.bak-$stamp-$index"
        $index += 1
    }
    return $candidate
}

$backup = New-BackupPath $manifestPath

if ($Remove) {
    if (Test-Path -LiteralPath $linkPath) {
        $item = Get-Item -LiteralPath $linkPath -Force
        if ($item.LinkType) { $item.Delete() } else { Remove-Item -LiteralPath $linkPath -Recurse -Force }
        Write-Host "removed junction $linkPath" -ForegroundColor Yellow
    }
    $dependencies.Remove($packageName)
    $bundles = @($bundles | Where-Object { $_ -ne $packageName })
    Copy-Item -LiteralPath $manifestPath -Destination $backup
    Set-OrAddProperty $manifest 'dependencies' $dependencies
    Set-OrAddProperty $manifest.dsh.profile 'bundles' $bundles
    Write-JsonUtf8 $manifestPath $manifest
    Write-Host "uninstalled; backed up manifest to $backup" -ForegroundColor Green
    Write-Host "Fully restart the desktop app." -ForegroundColor Cyan
    return
}

New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item -LiteralPath $linkPath -Recurse -Force }
}
$target = [System.IO.Path]::GetFullPath($RepoPath)
New-Item -ItemType Junction -Path $linkPath -Target $target | Out-Null
Write-Host "linked $linkPath -> $target" -ForegroundColor Green

if (-not $dependencies.Contains($packageName)) {
    $dependencies[$packageName] = "file:$target"
}
if ($bundles -notcontains $packageName) {
    $bundles += $packageName
}

Copy-Item -LiteralPath $manifestPath -Destination $backup
Set-OrAddProperty $manifest 'dependencies' $dependencies
Set-OrAddProperty $manifest.dsh.profile 'bundles' $bundles
Write-JsonUtf8 $manifestPath $manifest

Write-Host "installed dsh-easy-sync into the desktop profile" -ForegroundColor Green
Write-Host "  backup: $backup"
Write-Host "Fully quit and reopen DeepSeek Harness for the plugin to load." -ForegroundColor Cyan
