"use client";
import { createContext, useContext, useMemo, useRef, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { WagmiProvider, createConfig, useAccount, useWriteContract } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { http, type Abi, type Address } from "viem";
import { toast, Toaster } from "sonner";
import { userError, type Citizen, type Receipt } from "@/lib/terra";
import { communityAbis, communityChain, communityClient, communityPath, decodeProposal, ledger, rootCommunity, verifyCommunity, type Community, type PageResponse, type ProposalJson, type SummaryResponse } from "@/lib/community";
import AgentTools from "@/components/agent-tools";
function useStateSource(community: Community, communityError: Error | null) {
  const account = useAccount(); const { writeContractAsync } = useWriteContract(); const queries = useQueryClient();
  const [receipt, setReceipt] = useState<(Receipt & { chainId: number; explorerUrl?: string }) | null>(null);
  const [busy, setBusy] = useState(false); const locked = useRef(false);
  const [filter, setFilter] = useState("all"); const [cursor, setCursor] = useState<string | null>(null);
  const chain = useMemo(() => communityChain(community), [community]);
  const publicClient = useMemo(() => communityClient(community), [community]);
  const abi = communityAbis(community); const key = [community.chainId, community.governor];
  const isDeployed = !!community.governor && (!community.status || ["active", "Active", "deployed"].includes(community.status));
  const verification = useQuery({ queryKey: ["verification", ...key, community.governorCodeHash, community.genesisHash], queryFn: () => verifyCommunity(community), enabled: isDeployed, staleTime: 60000, retry: 1 });
  const summary = useQuery({ queryKey: ["summary", ...key], queryFn: () => ledger<SummaryResponse>("communities/" + community.id), refetchInterval: 15000, retry: 1 });
  const proposals = useQuery({ queryKey: ["proposals", ...key, filter, cursor], queryFn: () => ledger<PageResponse<ProposalJson>>("communities/" + community.id + "/proposals?limit=20&state=" + ({ all: "", active: "Active", results: "Results" }[filter] ?? "") + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "")), enabled: isDeployed, refetchInterval: 15000, retry: 1 });
  const citizen = useQuery({ queryKey: ["member", ...key, account.address], enabled: isDeployed && !!account.address && !!abi.registry, retry: 1,
    queryFn: async () => { const data = await publicClient.readContract({ address: community.registry, abi: abi.registry, functionName: abi.member, args: [account.address!] }) as [bigint, bigint, bigint]; return { id: data[0], joinedAt: data[1], joinedBlock: data[2] } as Citizen; } });
  const data = isDeployed && summary.data?.counts && summary.data.source ? { count: BigInt(summary.data.counts.members), treasury: BigInt(summary.data.treasuryBalanceWei), proposals: (proposals.data?.items ?? []).map(decodeProposal), timestamp: Number(summary.data.source.timestamp ?? Math.floor(Date.now() / 1000)), source: summary.data.source } : undefined;
  const assembly = { data, isLoading: summary.isLoading || proposals.isLoading, isFetching: summary.isFetching || proposals.isFetching, isError: summary.isError || proposals.isError,
    error: summary.error ?? proposals.error, refetch: async () => { const result = await summary.refetch(); const page = isDeployed ? await proposals.refetch() : proposals; return { isError: result.isError || page.isError, data: isDeployed && result.data?.counts && result.data.source ? { count: BigInt(result.data.counts.members), treasury: BigInt(result.data.treasuryBalanceWei), proposals: (page.data?.items ?? []).map(decodeProposal), timestamp: Number(result.data.source.timestamp ?? Math.floor(Date.now()/1000)) } : undefined }; } };
  const transact = useCallback(async (label: string, address: Address, contractAbi: Abi, functionName: string, args: readonly unknown[], value?: bigint) => {
    if (locked.current) throw new Error("A wallet request is already in progress.");
    if (!isDeployed || !verification.data?.valid) throw new Error(verification.error?.message || "Wait for independent deployment verification before signing.");
    if (!account.address || account.chainId !== chain.id) throw new Error("Connect a wallet to " + chain.name + " first.");
    locked.current = true; setBusy(true); setReceipt(null);
    try {
      await verifyCommunity(community);
      await publicClient.simulateContract({ address, abi: contractAbi, functionName, args, account: account.address, ...(value === undefined ? {} : { value }) });
      const hash = await writeContractAsync({ address, abi: contractAbi, functionName, args, chainId: chain.id, ...(value === undefined ? {} : { value }) });
      toast.info("Transaction submitted. Waiting for confirmation.");
      const confirmed = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (confirmed.status !== "success") throw new Error("Transaction reverted");
      const result = { hash, block: confirmed.blockNumber, label, chainId: chain.id, explorerUrl: community.explorerUrl };
      setReceipt(result); toast.success(label);
      await Promise.all([queries.invalidateQueries({ queryKey: ["summary", ...key] }), queries.invalidateQueries({ queryKey: ["proposals", ...key] }), queries.invalidateQueries({ queryKey: ["proposal", ...key] }), queries.invalidateQueries({ queryKey: ["member", ...key] })]);
      return result;
    } catch (error) { toast.error(userError(error)); throw error; }
    finally { locked.current = false; setBusy(false); }
  }, [isDeployed, verification.data, verification.error, account.address, account.chainId, chain.id, chain.name, publicClient, writeContractAsync, community, queries]);
  return { account, assembly, citizen, now: data?.timestamp ?? Math.floor(Date.now()/1000), busy, receipt, transact, community, communityError, verification,
    chain, publicClient, governorAddress: community.governor, registryAddress: community.registry, governorAbi: abi.governor, registryAbi: abi.registry,
    memberFunction: abi.member, isDeployed, home: communityPath(community), href: (suffix: string) => communityPath(community, suffix),
    memberWord: community.kind === "terra" ? "citizen" : "stockholder", proposalWord: community.kind === "terra" ? "policy" : "resolution",
    explorer: (kind: "tx" | "address", value: string) => community.explorerUrl ? community.explorerUrl + "/" + kind + "/" + value : null,
    filter, cursor, nextCursor: proposals.data?.nextCursor ?? null, setFilter: (value: string) => { setFilter(value); setCursor(null); }, setCursor };
}
type TerraContext = ReturnType<typeof useStateSource>;
const Context = createContext<TerraContext | null>(null);
export function useTerra() { const value = useContext(Context); if (!value) throw new Error("Community provider is missing"); return value; }
export function useProposal(id: string) {
  const { community, isDeployed } = useTerra();
  return useQuery({ queryKey: ["proposal", community.chainId, community.governor, id], enabled: isDeployed,
    queryFn: async () => { const result = await ledger<{ proposal: ProposalJson }>("communities/" + community.id + "/proposals/" + id); return decodeProposal(result.proposal); }, refetchInterval: 15000, retry: 1 });
}
function CommunityState({ community, error, children }: { community: Community; error: Error | null; children: React.ReactNode }) {
  const value = useStateSource(community, error);
  return <Context.Provider value={value}><AgentTools />{children}<Toaster theme="light" richColors position="bottom-right" /></Context.Provider>;
}
function SelectedCommunity({ children }: { children: React.ReactNode }) {
  const path = usePathname(); const id = path.match(/^\/blockshares\/([1-9]\d*)(?:\/|$)/)?.[1] ?? "terra";
  const selected = useQuery({ queryKey: ["community", id], queryFn: async () => (await ledger<{ community: Community }>("communities/" + id + "/deployment")).community, refetchInterval: 15000, retry: 1 });
  const raw = selected.data ?? (id === "terra" ? rootCommunity : { ...rootCommunity, id, kind: "blockshares" as const, name: "Blockshare " + id, status: "Unavailable", governor: undefined, registry: undefined, rpcUrl: "" });
  const community: Community = { ...raw, governor: raw.governor ?? "0x0000000000000000000000000000000000000000", registry: raw.registry ?? "0x0000000000000000000000000000000000000000", rpcUrl: raw.rpcUrl || "http://127.0.0.1:1", deploymentBlock: raw.deploymentBlock || "0" };
  const config = useMemo(() => { const chain = communityChain(community); return createConfig({ chains: [chain], connectors: [injected()], ssr: true, transports: { [chain.id]: http(community.rpcUrl) } }); }, [community.chainId, community.rpcUrl, community.name]);
  return <WagmiProvider config={config} key={community.chainId}><CommunityState community={community} error={selected.error} key={community.chainId + ":" + community.governor + ":" + id}>{children}</CommunityState></WagmiProvider>;
}
export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5000, refetchOnWindowFocus: true } } }));
  return <QueryClientProvider client={queryClient}><SelectedCommunity>{children}</SelectedCommunity></QueryClientProvider>;
}
