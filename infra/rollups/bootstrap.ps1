$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$version = '1.20.0'
$commit = '84cd0961fcce613558d7b260d8751a3ace533d31'
New-Item -ItemType Directory -Path "$taskRoot\bin", "$taskRoot\downloads", "$taskRoot\vendor", "$taskRoot\runtime" -Force | Out-Null
if (-not (Test-Path -LiteralPath "$taskRoot\bin\kurtosis.exe")) {
  $archive = "kurtosis-cli_${version}_windows_amd64.tar.gz"
  $base = "https://github.com/kurtosis-tech/kurtosis-cli-release-artifacts/releases/download/$version"
  Invoke-WebRequest -Uri "$base/$archive" -OutFile "$taskRoot\downloads\$archive"
  Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile "$taskRoot\downloads\checksums.txt"
  $expected = (Get-Content "$taskRoot\downloads\checksums.txt" | Where-Object { $_.EndsWith("  $archive") }).Split(' ')[0]
  $actual = (Get-FileHash "$taskRoot\downloads\$archive" -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw 'Kurtosis archive checksum mismatch.' }
  tar -xzf "$taskRoot\downloads\$archive" -C "$taskRoot\bin"
  if ($LASTEXITCODE -ne 0) { throw 'Kurtosis archive extraction failed.' }
}
if (-not (Test-Path -LiteralPath "$taskRoot\vendor\optimism-package\.git")) {
  git clone --filter=blob:none https://github.com/ethpandaops/optimism-package.git "$taskRoot\vendor\optimism-package"
  if ($LASTEXITCODE -ne 0) { throw 'Optimism package clone failed.' }
  git -C "$taskRoot\vendor\optimism-package" checkout $commit
}
$current = git -C "$taskRoot\vendor\optimism-package" rev-parse HEAD
if ($current -ne $commit) { throw 'Existing vendor checkout differs from the supported commit; preserve it and investigate.' }
$env:DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine'
& "$taskRoot\bin\kurtosis.exe" version
docker info --format '{{.ServerVersion}}'
node "$taskRoot\prepare-packages.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Pinned package preparation failed.' }
