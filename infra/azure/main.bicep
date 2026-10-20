targetScope = 'subscription'

param location string = 'eastus'
param resourceGroupName string = 'rg-terra-mvp-eastus'
param zone string = '1'
param adminUsername string = 'terraadmin'
@minLength(64)
param adminSshPublicKey string
param budgetEmail string = ''
param budgetStartDate string = utcNow('yyyy-MM-01T00:00:00Z')

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    project: 'Terra'
    environment: 'mvp'
    managedBy: 'terra-azure-mvp'
  }
}

module host './host.bicep' = {
  name: 'terra-mvp-host'
  scope: group
  params: {
    location: location
    zone: zone
    adminUsername: adminUsername
    adminSshPublicKey: adminSshPublicKey
    budgetEmail: budgetEmail
    budgetStartDate: budgetStartDate
  }
}

output resourceGroup string = group.name
output vmName string = host.outputs.vmName
output hostname string = host.outputs.hostname
output vaultUrl string = host.outputs.vaultUrl
output storageAccount string = host.outputs.storageAccount
output dataDiskId string = host.outputs.dataDiskId
