import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isAddress, type Address } from 'viem';
import { keccak256 } from 'viem';
import { decimal, type Community } from './types.js';

export const root = resolve(import.meta.dirname, '..', '..');
export const runtimePath = resolve(process.env.TERRA_RUNTIME ?? resolve(root, 'services/runtime'));
export { getDatabaseUrl } from './database-config.js';

function address(value: unknown, label: string): Address | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`Invalid ${label} address`);
  return value as Address;
}
export function normalizeCommunity(raw: Record<string, unknown>, index = 0): Community {
  const status = String(raw.status ?? 'Active');
  const kind = raw.kind === 'blockshares' || raw.governanceKind === 'blockshares' ? 'blockshares' : 'terra';
  const deployed = status.toLowerCase() === 'deployed' || status.toLowerCase() === 'active';
  const chainId = decimal(raw.chainId ?? '31337', 'chainId');
  const rpcUrl = String(raw.rpcUrl ?? '');
  if (rpcUrl) {
    const url = new URL(rpcUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC must be HTTP(S)');
  }
  const local = raw.local === true || rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost');
  const finality = raw.finality === 'safe' || raw.finality === 'latest' ? raw.finality : local && chainId === '31337' ? 'latest' : 'finalized';
  const community: Community = {
    ...raw,
    id: String(raw.id ?? (kind === 'terra' ? 'terra' : index)),
    kind,
    governanceKind: String(raw.governanceKind ?? kind),
    name: String(raw.name ?? (kind === 'terra' ? 'Terra' : `Blockshare ${index}`)),
    chainId,
    rpcUrl,
    governor: address(raw.governor, 'governor'),
    registry: address(raw.registry, 'registry'),
    directory: address(raw.directory, 'directory'),
    deploymentBlock: decimal(raw.deploymentBlock ?? '0', 'deploymentBlock'),
    status: deployed ? 'Active' : ['Approved', 'Provisioning', 'Failed'].includes(status) ? status as Community['status'] : 'Approved',
    testnet: raw.testnet !== false,
    local,
    finality,
  };
  if (!/^(terra|[a-zA-Z0-9_-]{1,100})$/.test(community.id)) throw new Error('Invalid community id');
  if (deployed && (!community.governor || !community.registry || !rpcUrl)) throw new Error('Active community needs governance addresses and RPC');
  return community;
}

export async function loadProtocol(): Promise<Record<string, unknown> & { communities: Community[] }> {
  const candidates = process.env.TERRA_MANIFEST ? [resolve(process.env.TERRA_MANIFEST)] :
    [resolve(runtimePath, 'manifest.json'), resolve(root, 'infra/runtime/manifest.json'), resolve(root, 'web/lib/multichain-manifest.json'), resolve(root, 'web/lib/deployment.json')];
  for (const path of candidates) {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const list = Array.isArray(raw.communities) ? raw.communities : Array.isArray(raw.chains) ? raw.chains : [raw];
      const communities = list.map((item, index) => normalizeCommunity(item as Record<string, unknown>, index));
      const ids = new Set<string>();
      const keys = new Set<string>();
      for (const community of communities) {
        if (ids.has(community.id)) throw new Error('Duplicate community id');
        ids.add(community.id);
        if (community.governor) {
          const key = `${community.chainId}:${community.governor.toLowerCase()}`;
          if (keys.has(key)) throw new Error('Duplicate deployed governance identity');
          keys.add(key);
        }
      }
      return { ...raw, version: 2, communities };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('No Terra manifest found');
}
export async function loadManifest(): Promise<Community[]> { return (await loadProtocol()).communities; }
export async function loadNetworkSpec(): Promise<Record<string, unknown>> {
  const path = process.env.TERRA_NETWORK_SPEC ? resolve(process.env.TERRA_NETWORK_SPEC) : resolve(root,'operator/network-spec.json');
  const raw = JSON.parse(await readFile(path,'utf8')) as Record<string, unknown>;
  if (!raw.specification || typeof raw.specification!=='object' || raw.governanceVersion!==1 ||
      raw.chainSpecHash!==keccak256(Buffer.from(JSON.stringify(raw.specification)))) throw new Error('Invalid or unverifiable operator network specification');
  decimal(raw.settlementChainId,'settlementChainId');
  return {governanceVersion:1,chainSpecHash:raw.chainSpecHash,description:String(raw.description),settlementChainId:String(raw.settlementChainId)};
}
