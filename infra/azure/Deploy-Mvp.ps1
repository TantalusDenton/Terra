[CmdletBinding()]
param(
  [string]$SubscriptionId,
  [string]$ResourceGroupName = 'rg-terra-mvp-eastus',
  [string]$Location = 'eastus',
  [ValidateSet('1','2','3')][string]$Zone = '1',
  [string]$SshPublicKeyFile,
  [string]$BudgetEmail = '',
  [switch]$Deploy
)
$ErrorActionPreference = 'Stop'
$terraAz = & (Join-Path $PSScriptRoot 'Get-AzureCli.ps1')
function Invoke-TerraAzureJson {
  param([string[]]$Arguments)
  $terraResult = & $terraAz @Arguments --only-show-errors --output json
  if ($LASTEXITCODE -ne 0) { throw ('Azure command failed: ' + (($Arguments | Select-Object -First 3) -join ' ')) }
  if ($terraResult) { ($terraResult -join "`n") | ConvertFrom-Json }
}

$terraAccount = Invoke-TerraAzureJson @('account','show')
if ($SubscriptionId) {
  $terraAccount = Invoke-TerraAzureJson @('account','show','--subscription',$SubscriptionId)
}
if (-not $terraAccount -or $terraAccount.state -ne 'Enabled') { throw 'Sign in to an enabled Azure subscription with az login before deployment.' }
$SubscriptionId = $terraAccount.id
if (-not $SubscriptionId) { throw 'Azure returned no subscription ID.' }
if ($ResourceGroupName -notmatch '^rg-terra-mvp-[a-z0-9-]+$') { throw 'Use a dedicated rg-terra-mvp-* resource group.' }
$terraScope = @('--subscription',$SubscriptionId)

foreach ($terraProviderName in @('Microsoft.Compute','Microsoft.Network','Microsoft.Storage','Microsoft.KeyVault')) {
  $terraProvider = Invoke-TerraAzureJson (@('provider','show','--namespace',$terraProviderName) + $terraScope)
  if ($terraProvider.registrationState -ne 'Registered') {
    if (-not $Deploy) { throw ('Register ' + $terraProviderName + ' or run the authorized apply with -Deploy to initialize the required provider.') }
    $null = Invoke-TerraAzureJson (@('provider','register','--namespace',$terraProviderName,'--wait') + $terraScope)
  }
}

$terraGroupExists = Invoke-TerraAzureJson (@('group','exists','--name',$ResourceGroupName) + $terraScope)
$terraExistingVm = $false
if ($terraGroupExists) {
  $terraGroup = Invoke-TerraAzureJson (@('group','show','--name',$ResourceGroupName) + $terraScope)
  if ($terraGroup.tags.managedBy -ne 'terra-azure-mvp') { throw 'Existing resource group is not managed by this deployment. No resources were changed.' }
  $terraVms = @(Invoke-TerraAzureJson (@('vm','list','--resource-group',$ResourceGroupName) + $terraScope))
  $terraExistingVm = @($terraVms | Where-Object name -eq 'terra-mvp-vm').Count -eq 1
}

$terraSkus = @(Invoke-TerraAzureJson (@('vm','list-skus','--location',$Location,'--resource-type','virtualMachines','--size','Standard_D16as_v5','--all') + $terraScope))
$terraSku = $terraSkus | Where-Object name -eq 'Standard_D16as_v5' | Select-Object -First 1
if (-not $terraSku -or $Zone -notin @($terraSku.locationInfo[0].zones)) { throw 'The selected VM size/zone is unavailable in this subscription.' }
foreach ($terraRestriction in $terraSku.restrictions) {
  if ($terraRestriction.type -eq 'Location' -or ($terraRestriction.type -eq 'Zone' -and $Zone -in @($terraRestriction.restrictionInfo.zones))) {
    throw ('Azure restricts this VM size/zone: ' + $terraRestriction.reasonCode)
  }
}
$terraUsage = @(Invoke-TerraAzureJson (@('vm','list-usage','--location',$Location) + $terraScope))
if (-not $terraExistingVm) {
  foreach ($terraQuotaName in @('cores',$terraSku.family)) {
    $terraQuota = $terraUsage | Where-Object { $_.name.value -ieq $terraQuotaName } | Select-Object -First 1
    if (-not $terraQuota -or ($terraQuota.limit - $terraQuota.currentValue) -lt 16) { throw ('At least 16 available vCPUs are required in quota ' + $terraQuotaName + '. No paid resources were created.') }
  }
}
$terraDiskSkus = @(Invoke-TerraAzureJson (@('vm','list-skus','--location',$Location,'--resource-type','disks','--all') + $terraScope))
$terraDiskSku = $terraDiskSkus | Where-Object name -eq 'PremiumV2_LRS' | Select-Object -First 1
if (-not $terraDiskSku -or $Zone -notin @($terraDiskSku.locationInfo[0].zones)) { throw 'Premium SSD v2 is not available in the selected zone.' }

if (-not $SshPublicKeyFile) { $SshPublicKeyFile = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh/id_ed25519.pub' }
if (-not (Test-Path -LiteralPath $SshPublicKeyFile)) { throw 'Supply an existing SSH public key with -SshPublicKeyFile. Private keys are never uploaded.' }
$terraSshPublicKey = (Get-Content -LiteralPath $SshPublicKeyFile -Raw).Trim()
if ($terraSshPublicKey -notmatch '^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]+)?$') { throw 'Invalid SSH public key.' }

$terraRuntime = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Path $terraRuntime -Force | Out-Null
$terraParameters = @{
  '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
  contentVersion = '1.0.0.0'
  parameters = @{
    location = @{value=$Location}
    resourceGroupName = @{value=$ResourceGroupName}
    zone = @{value=$Zone}
    adminSshPublicKey = @{value=$terraSshPublicKey}
    budgetEmail = @{value=$BudgetEmail}
  }
}
$terraParameterPath = Join-Path $terraRuntime 'parameters.json'
[IO.File]::WriteAllText($terraParameterPath,($terraParameters | ConvertTo-Json -Depth 8))
$terraTemplatePath = Join-Path $terraRuntime 'main.json'
& $terraAz bicep build --file (Join-Path $PSScriptRoot 'main.bicep') --outfile $terraTemplatePath --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Bicep compilation failed.' }

$terraArguments = @('--name','terra-mvp','--location',$Location,'--template-file',$terraTemplatePath,'--parameters',('@'+$terraParameterPath)) + $terraScope
$null = Invoke-TerraAzureJson (@('deployment','sub','validate') + $terraArguments)
$terraPlan = Invoke-TerraAzureJson (@('deployment','sub','what-if','--no-pretty-print') + $terraArguments)
[IO.File]::WriteAllText((Join-Path $terraRuntime 'what-if.json'),($terraPlan | ConvertTo-Json -Depth 100))
if (@($terraPlan.changes | Where-Object changeType -eq 'Delete').Count) { throw 'The Azure plan contains deletions; deployment was stopped.' }
Write-Host ('Subscription: ' + $terraAccount.name)
Write-Host ('Resource group: ' + $ResourceGroupName + '; location: ' + $Location + '; zone: ' + $Zone)
Write-Host 'MVP: 16 vCPU / 64 GiB Linux, 2 TiB Premium SSD v2, private Key Vault and backup storage.'
Write-Host 'Estimated backend: USD 750-850/month; USD 900 budget is monitoring, not a spending cap.'
if (-not $Deploy) { Write-Host 'Validated plan saved in infra/azure/runtime/what-if.json. Use -Deploy to apply it.'; return }
$terraDeployment = Invoke-TerraAzureJson (@('deployment','sub','create') + $terraArguments)
$terraOutputs = $terraDeployment.properties.outputs
if (-not $terraOutputs.vmName.value -or -not $terraOutputs.hostname.value) { throw 'Deployment returned no VM identity. Inspect its Azure deployment record before retrying.' }
$terraResult = @{
  subscriptionId=$SubscriptionId; resourceGroup=$ResourceGroupName; location=$Location; zone=$Zone
  vmName=$terraOutputs.vmName.value; hostname=$terraOutputs.hostname.value; vaultUrl=$terraOutputs.vaultUrl.value
  storageAccount=$terraOutputs.storageAccount.value; dataDiskId=$terraOutputs.dataDiskId.value
  infrastructureStatus='Succeeded'; applicationStatus='NotBootstrapped'; recordedAt=[DateTime]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText((Join-Path $terraRuntime 'deployment.json'),($terraResult | ConvertTo-Json -Depth 8))
$terraResult | ConvertTo-Json
