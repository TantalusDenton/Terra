[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$terraCliVersion = '2.91.0'
$terraInstalledCli = Get-Command az -ErrorAction SilentlyContinue
if ($terraInstalledCli) { $terraInstalledCli.Source; return }
$terraToolRoot = Join-Path $PSScriptRoot 'runtime'
$terraCliRoot = Join-Path $terraToolRoot "azure-cli-$terraCliVersion"
$terraCli = Join-Path $terraCliRoot 'bin/az.cmd'
if (-not (Test-Path -LiteralPath $terraCli)) {
  New-Item -ItemType Directory -Path $terraToolRoot -Force | Out-Null
  $terraArchive = Join-Path $terraToolRoot "azure-cli-$terraCliVersion-x64.zip"
  if (-not (Test-Path -LiteralPath $terraArchive)) {
    Invoke-WebRequest -Uri "https://azcliprod.blob.core.windows.net/zip/azure-cli-$terraCliVersion-x64.zip" -OutFile $terraArchive
  }
  Expand-Archive -LiteralPath $terraArchive -DestinationPath $terraCliRoot
}
if (-not (Test-Path -LiteralPath $terraCli)) { throw 'The Microsoft Azure CLI package did not contain bin/az.cmd.' }
$terraCli
