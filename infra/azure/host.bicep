param location string = resourceGroup().location
@allowed(['1', '2', '3'])
param zone string
param adminUsername string
@minLength(64)
param adminSshPublicKey string
param budgetEmail string = ''
param budgetStartDate string

var suffix = uniqueString(resourceGroup().id)
var prefix = 'terra-mvp'
var tags = {
  project: 'Terra'
  environment: 'mvp'
  managedBy: 'terra-azure-mvp'
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${prefix}-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [for rule in [{ name: 'HTTP', port: '80', priority: 100 }, { name: 'HTTPS', port: '443', priority: 110 }]: {
      name: rule.name
      properties: {
        priority: rule.priority
        direction: 'Inbound'
        access: 'Allow'
        protocol: 'Tcp'
        sourceAddressPrefix: 'Internet'
        sourcePortRange: '*'
        destinationAddressPrefix: '*'
        destinationPortRange: rule.port
      }
    }]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.81.0.0/16'] }
  }
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'terra'
  properties: {
    addressPrefix: '10.81.0.0/24'
    networkSecurityGroup: { id: nsg.id }
    serviceEndpoints: [
      { service: 'Microsoft.KeyVault' }
      { service: 'Microsoft.Storage' }
    ]
  }
}

resource ip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${prefix}-ip'
  location: location
  tags: tags
  zones: [zone]
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: { domainNameLabel: '${prefix}-${suffix}' }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${prefix}-nic'
  location: location
  tags: tags
  properties: {
    enableAcceleratedNetworking: true
    ipConfigurations: [{
      name: 'primary'
      properties: {
        privateIPAllocationMethod: 'Dynamic'
        subnet: { id: subnet.id }
        publicIPAddress: { id: ip.id }
      }
    }]
  }
}

resource data 'Microsoft.Compute/disks@2024-03-02' = {
  name: '${prefix}-data'
  location: location
  zones: [zone]
  tags: tags
  sku: { name: 'PremiumV2_LRS' }
  properties: {
    creationData: { createOption: 'Empty' }
    diskSizeGB: 2048
    diskIOPSReadWrite: 3000
    diskMBpsReadWrite: 125
    networkAccessPolicy: 'DenyAll'
    publicNetworkAccess: 'Disabled'
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: '${prefix}-vm'
  location: location
  zones: [zone]
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: 'Standard_D16as_v5' }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        name: '${prefix}-os'
        createOption: 'FromImage'
        deleteOption: 'Detach'
        diskSizeGB: 64
        managedDisk: { storageAccountType: 'Premium_LRS' }
      }
      dataDisks: [{
        lun: 0
        name: data.name
        createOption: 'Attach'
        deleteOption: 'Detach'
        caching: 'None'
        managedDisk: { id: data.id }
      }]
    }
    osProfile: {
      computerName: 'terra-mvp'
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [{
            path: '/home/${adminUsername}/.ssh/authorized_keys'
            keyData: adminSshPublicKey
          }]
        }
        patchSettings: {
          patchMode: 'AutomaticByPlatform'
          assessmentMode: 'AutomaticByPlatform'
        }
      }
    }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
    }
    diagnosticsProfile: { bootDiagnostics: { enabled: true } }
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'terramvp-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [{ id: subnet.id }]
      ipRules: []
    }
    accessPolicies: []
  }
}

resource operatorSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, vm.id, 'secrets-officer')
  scope: vault
  properties: {
    principalId: vm.identity!.principalId!
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'terramvp${suffix}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  tags: tags
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [{ id: subnet.id, action: 'Allow' }]
      ipRules: []
    }
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
    isVersioningEnabled: true
  }
}

resource backups 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'terra-backups'
  properties: { publicAccess: 'None' }
}

resource blobWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, vm.id, 'blob-writer')
  scope: storage
  properties: {
    principalId: vm.identity!.principalId!
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'terra-mvp-monthly'
  properties: {
    category: 'Cost'
    amount: 900
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: empty(budgetEmail) ? {} : {
      Actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [budgetEmail]
      }
      Forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [budgetEmail]
      }
    }
  }
}

output vmName string = vm.name
output hostname string = ip.properties.dnsSettings!.fqdn!
output vaultUrl string = vault.properties.vaultUri!
output storageAccount string = storage.name
output dataDiskId string = data.id
