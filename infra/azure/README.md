# Azure MVP deployment

This profile targets one Linux VM with 16 vCPUs, 64 GiB RAM and a 2 TiB Premium
SSD v2 data disk in East US. Signing secrets use Key Vault and the VM's managed
identity. The existing Windows DPAPI keys and local ledgers are not migrated or
replaced. Infrastructure provisioning alone does not mean the application or
OP Stack acceptance journey has completed.

The native Windows controller does not invoke WSL or local Docker. Downloaded
tools, account-specific parameters, plan output and deployment receipts remain in
ignored `runtime/`. Only the SSH public key is sent to Azure. No inbound SSH,
database, Docker, engine API, or node administrative ports are opened.

```powershell
$terraAz = ./infra/azure/Get-AzureCli.ps1
& $terraAz login --use-device-code
# Validate quota, availability and the Azure resource plan:
./infra/azure/Deploy-Mvp.ps1
# Apply the reviewed plan to the selected/default signed-in subscription:
./infra/azure/Deploy-Mvp.ps1 -Deploy
```

Use `-SubscriptionId` when selecting a nondefault subscription. `-BudgetEmail`
optionally enables notifications at 80% actual spend and 100% forecast spend.
The $900 monthly Azure budget does not stop resources or cap the bill. The
controller rejects an existing resource group owned by another workflow,
insufficient quota and planned deletions. Disk deletion behavior is `Detach`;
do not delete the resource group as a recovery action.

After infrastructure succeeds, remote software/bootstrap, HTTPS configuration,
verified root governance deployment and the real one-hour corporate approval
journey are still required. An Azure receipt must not be presented as completion
of those gates. Run Commands execute only on the Azure Linux VM; the local
Windows workstation remains subject to its WSL/Docker restriction.

The web source supports an explicit Node build with `npm run build:node` and
`npm run start:node`. The normal Sites/Cloudflare commands retain their existing
behavior. The Node server binds loopback; an HTTPS reverse proxy is required for
public access. Public chain/RPC addressing and the remote service bootstrap must
be completed before a public application handoff.

The Linux operator's cloud signer adapter requires these nonsecret settings:

| Setting | Value on the Azure VM |
| --- | --- |
| `TERRA_SIGNER_BACKEND` | `azure-key-vault` |
| `TERRA_AZURE_VAULT_URL` | `vaultUrl` from the deployment receipt |
| `TERRA_SIGNER_PUBLIC_DIRECTORY` | Durable directory for public wallet identities and initialization locks |
| `TERRA_OPERATOR_STATE_DIR` | Durable directory for provisioning checkpoints and network artifacts |
| `TERRA_MANIFEST` | Durable public protocol manifest path |
| `TERRA_RUNTIME` | Durable ledger-service runtime directory |

Key Vault secrets contain the deployer/operator signing keys. VM managed identity
authorizes access; secrets are never returned by the public status commands.
This MVP adapter loads keys into the operator process to sign Ethereum payloads;
it is not a nonexportable HSM signer. The per-signer initialization lock is local
to this single host. A distributed provisioning deployment requires a distributed
lease. Missing secrets with existing wallet identity records and soft-deleted
secrets fail without generating replacement identities.
