# Recover only this observed missing transient service. No ledger/key/artifact
# volume is mounted or changed. A temporary inert container lets the supported
# Kurtosis removal command clear its stale registration without editing its DB.
param(
  [ValidateSet('544537d8a0934b0284bcb8cfc08412b2', '4ee1b38cd00e4a1ab55e57fdfecbd22a')]
  [string]$taskUuid = '544537d8a0934b0284bcb8cfc08412b2'
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskEnclave = '1a4fa302c1064ce1b8b27fa69e3272f8'
$taskName = 'validator-key-generation-cl-validator-keystore'
$taskContainer = "$taskName--$taskUuid"
$taskImage = 'protolambda/eth2-val-tools@sha256:46147228f291266148a6a21a2b9541367ad5f70e619d79cd5393459baf539f58'
$env:DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine'
$taskEngine = docker info --format '{{.ID}}'
if ($LASTEXITCODE -ne 0 -or $taskEngine.Trim() -ne 'f839518c-49c7-4421-98e8-5e40be6e1fbc') { throw 'Original Docker engine unavailable; no mutation.' }
$taskArchive = Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'operator/state/networks/2151908/initial-genesis/genesis.json') | ConvertFrom-Json
$taskTimestamp = if ([string]$taskArchive.timestamp -match '^0x') { [Convert]::ToInt64($taskArchive.timestamp.Substring(2), 16) } else { [Int64]$taskArchive.timestamp }
if ($taskTimestamp -ne 1791611418) { throw 'Original genesis archive differs; no mutation.' }
docker volume inspect "data-el-1-geth-lighthouse--$taskEnclave" --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) { throw 'Original ledger volume unavailable; no mutation.' }
$taskExisting = docker ps -a --filter "label=com.kurtosistech.guid=$taskUuid" --format '{{.ID}}'
if ($LASTEXITCODE -ne 0 -or $taskExisting) { throw 'Target container is not confirmed absent; no mutation.' }
$taskInspect = & (Join-Path $PSScriptRoot 'bin/kurtosis.exe') enclave inspect --full-uuids terra-settlement 2>&1 | Out-String
if ($taskInspect -notmatch "couldn't find service with uuid '$taskUuid'" -or $taskInspect -notmatch $taskEnclave) { throw 'Expected stale registration was not established; no mutation.' }
docker run -d --name $taskContainer --network none --entrypoint sleep `
  --label 'com.kurtosistech.app-id=kurtosis' `
  --label 'com.kurtosistech.container-type=user-service' `
  --label "com.kurtosistech.enclave-id=$taskEnclave" `
  --label 'com.kurtosistech.enclave-name=terra-settlement' `
  --label "com.kurtosistech.guid=$taskUuid" --label "com.kurtosistech.id=$taskName" `
  --label 'com.kurtosistech.ports=' --label 'com.kurtosistech.private-ip=172.16.0.5' `
  --label "kurtosis_service_uuid=$taskUuid" --label "kurtosis_service_name=$taskName" `
  --label "kurtosis_enclave_uuid=$taskEnclave" --label 'kurtosis_enclave_name=terra-settlement' `
  --label 'terra.recovery-placeholder=true' $taskImage 99999
if ($LASTEXITCODE -ne 0) { throw 'Recovery placeholder failed; original data is unchanged.' }
& (Join-Path $PSScriptRoot 'bin/kurtosis.exe') service rm terra-settlement $taskName
if ($LASTEXITCODE -ne 0) { throw 'Kurtosis removal failed; preserve placeholder for inspection.' }
& (Join-Path $PSScriptRoot 'bin/kurtosis.exe') enclave inspect --full-uuids terra-settlement
if ($LASTEXITCODE -ne 0) { throw 'Post-recovery inspection failed.' }
