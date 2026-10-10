"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, createWalletClient, custom, defineChain, http, parseAbi, parseEther, type Address, type Chain, type Hex } from "viem";
import { buildProveWithdrawal, getGame, getL2TransactionHashes, getWithdrawals, getWithdrawalStatus } from "viem/op-stack";
import { useTerra } from "@/app/providers";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { WalletControl } from "./terra-shell";
import { verifyCommunity } from "@/lib/community";
const bridgeAbi = parseAbi(["function bridgeETHTo(address to,uint32 minGasLimit,bytes extraData) payable"]);
const portalAbi = parseAbi([
  "function proofMaturityDelaySeconds() view returns (uint256)", "function disputeGameFinalityDelaySeconds() view returns (uint256)",
  "function proveWithdrawalTransaction((uint256 nonce,address sender,address target,uint256 value,uint256 gasLimit,bytes data) withdrawal,uint256 l2OutputIndex,(bytes32 version,bytes32 stateRoot,bytes32 messagePasserStorageRoot,bytes32 latestBlockhash) outputRootProof,bytes[] withdrawalProof)",
  "function finalizeWithdrawalTransactionExternalProof((uint256 nonce,address sender,address target,uint256 value,uint256 gasLimit,bytes data) withdrawal,address proofSubmitter)",
  "function proofSubmitters(bytes32 withdrawalHash,uint256 index) view returns (address)", "function numProofSubmitters(bytes32 withdrawalHash) view returns (uint256)",
]);
export default function Bridge() {
  const { community, account, chain, publicClient: l2, verification } = useTerra(); const bridges = community.bridges;
  const settlement = useMemo(() => bridges ? defineChain({ id: Number(bridges.settlementChainId), name: bridges.settlementName || "Ethereum settlement testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [bridges.settlementRpcUrl] } }, testnet: community.testnet !== false }) : null, [bridges, community.testnet]);
  const l1 = useMemo(() => settlement ? createPublicClient({ chain: settlement, transport: http(bridges!.settlementRpcUrl, { timeout: 15000 }) }) : null, [settlement, bridges]);
  const [amount, setAmount] = useState("0.01"); const [withdrawalHash, setWithdrawalHash] = useState(""); const [depositHash, setDepositHash] = useState<Hex | null>(null);
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [receipts, setReceipts] = useState<{ hash: Hex; network: string; block: string; explorer?: string; label: string }[]>([]);
  const withdrawal = useQuery({ queryKey: ["withdrawal", community.chainId, community.governor, withdrawalHash], enabled: !!bridges && /^0x[0-9a-fA-F]{64}$/.test(withdrawalHash), refetchInterval: 15000,
    queryFn: async () => { const receipt = await l2.getTransactionReceipt({ hash: withdrawalHash as Hex }); if (receipt.status !== "success") throw new Error("Withdrawal initiation reverted."); const [message] = getWithdrawals(receipt); if (!message) throw new Error("This receipt contains no canonical withdrawal."); const status = await getWithdrawalStatus(l1!, { receipt, portalAddress: bridges!.optimismPortal, disputeGameFactoryAddress: bridges!.disputeGameFactory! }); return { receipt, message, status }; }, retry: 1 });
  const deposits = useQuery({ queryKey: ["deposit", community.chainId, depositHash], enabled: !!depositHash && !!l1, refetchInterval: 15000,
    queryFn: async () => { const receipt = await l1!.getTransactionReceipt({ hash: depositHash! }); const hashes = getL2TransactionHashes(receipt); if (!hashes.length) throw new Error("No canonical deposit message found."); const receipts = await Promise.all(hashes.map(hash => l2.getTransactionReceipt({ hash }).catch(() => null))); return receipts.every(receipt => receipt?.status === "success") ? "Deposited on " + community.name : "Settlement confirmed; waiting for rollup relay"; }, retry: 1 });
  const delays = useQuery({ queryKey: ["bridge-delays", bridges?.settlementChainId, bridges?.optimismPortal], enabled: !!l1 && !!bridges,
    queryFn: () => Promise.all((["proofMaturityDelaySeconds", "disputeGameFinalityDelaySeconds"] as const).map(functionName => l1!.readContract({ address: bridges!.optimismPortal, abi: portalAbi, functionName }))), staleTime: 60000, retry: 1 });
  async function wallet(target: Chain) {
    if (!account.address || !account.connector) throw new Error("Connect a wallet first.");
    const provider = await account.connector.getProvider();
    const client = createWalletClient({ account: account.address, chain: target, transport: custom(provider as Parameters<typeof custom>[0]) });
    try { await client.switchChain({ id: target.id }); } catch (e) { if (!/4902|unknown chain|unrecognized chain|not.*added/i.test(String(e))) throw e; await client.addChain({ chain: target }); await client.switchChain({ id: target.id }); }
    return client;
  }
  async function run(action: "deposit" | "withdraw" | "prove" | "finalize") {
    if (pending || !bridges || !l1 || !settlement) return; setPending(true); setError("");
    try {
      if (!verification.data?.valid) throw new Error("Wait for independent network verification.");
      await verifyCommunity(community);
      if (String(await l1.getChainId()) !== bridges.settlementChainId) throw new Error("The settlement RPC returned a different network.");
      const onL1 = action !== "withdraw"; const target = onL1 ? settlement : chain; const signer = await wallet(target); const rpc = onL1 ? l1 : l2; const accountAddress = account.address!;
      let hash: Hex;
      if (action === "deposit" || action === "withdraw") {
        if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(amount)) throw new Error("Enter a positive ETH amount with up to 18 decimal places."); const value = parseEther(amount); if (value <= 0n) throw new Error("Enter a positive ETH amount.");
        const address = action === "deposit" ? bridges.l1StandardBridge : bridges.l2StandardBridge;
        const request = await rpc.simulateContract({ address, abi: bridgeAbi, functionName: "bridgeETHTo", args: [accountAddress, 200000, "0x"], account: accountAddress, value });
        hash = await signer.writeContract(request.request);
      } else {
        if (!withdrawal.data) throw new Error("Load a withdrawal initiation receipt first."); const { message, receipt, status } = withdrawal.data;
        if (action === "prove") {
          if (status !== "ready-to-prove") throw new Error("This withdrawal is not ready for proof submission.");
          const game = await getGame(l1, { l2BlockNumber: receipt.blockNumber, portalAddress: bridges.optimismPortal, disputeGameFactoryAddress: bridges.disputeGameFactory! });
          const proof = await buildProveWithdrawal(l2, { account: accountAddress, game, withdrawal: message });
          const request = await l1.simulateContract({ address: bridges.optimismPortal, abi: portalAbi, functionName: "proveWithdrawalTransaction", args: [proof.withdrawal, proof.l2OutputIndex, proof.outputRootProof, proof.withdrawalProof], account: accountAddress });
          hash = await signer.writeContract(request.request);
        } else {
          if (status !== "ready-to-finalize") throw new Error("The deployed bridge's finalization conditions have not been met.");
          const count = await l1.readContract({ address: bridges.optimismPortal, abi: portalAbi, functionName: "numProofSubmitters", args: [message.withdrawalHash] });
          const submitter = await l1.readContract({ address: bridges.optimismPortal, abi: portalAbi, functionName: "proofSubmitters", args: [message.withdrawalHash, count - 1n] });
          const request = await l1.simulateContract({ address: bridges.optimismPortal, abi: portalAbi, functionName: "finalizeWithdrawalTransactionExternalProof", args: [message, submitter], account: accountAddress });
          hash = await signer.writeContract(request.request);
        }
      }
      const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 120000 }); if (receipt.status !== "success") throw new Error("Bridge transaction reverted.");
      setReceipts(items => [{ hash, network: target.name, block: receipt.blockNumber.toString(), explorer: onL1 ? bridges.settlementExplorerUrl : community.explorerUrl, label: action }, ...items]);
      if (action === "withdraw") setWithdrawalHash(hash); if (action === "deposit") setDepositHash(hash); if (action === "prove" || action === "finalize") await withdrawal.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "The bridge transaction could not be completed."); } finally { setPending(false); }
  }
  if (!bridges || !settlement || !bridges.disputeGameFactory) return <section className="panel empty-state"><h1>Bridge available on rollup profiles.</h1><p>This network has no complete verified canonical bridge configuration. Launch the local rollup profile to transfer test ETH.</p></section>;
  return <><div className="page-heading"><div><p className="eyebrow">CANONICAL ETH BRIDGE</p><h1>Fund your assembly wallet.</h1><p className="lede">{settlement.name} ↔ {community.name}. Each step is a separate wallet transaction.</p></div></div><div className="assembly-layout"><section className="panel"><div className="panel-body"><label className="field-label" htmlFor="bridge-amount">ETH amount</label><Input id="bridge-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /><p className="small-note">You pay network gas separately. Bridge transfers use your wallet funds, not the treasury.</p>{!account.address ? <WalletControl /> : <div className="filter-tabs"><Button disabled={pending || !verification.data?.valid} onClick={() => void run("deposit")}>Deposit to {community.name}</Button><Button variant="outline" disabled={pending || !verification.data?.valid} onClick={() => void run("withdraw")}>Withdraw to settlement</Button></div>}{depositHash && <div className="bridge-receipt"><strong>{deposits.data || "Reading deposit relay status…"}</strong><code className="address-block">{depositHash}</code>{deposits.isError && <p role="alert">Deposit relay status is unavailable. Refresh before assuming delivery.</p>}</div>}
      <hr /><label className="field-label" htmlFor="withdrawal-hash">Resume a withdrawal using its rollup transaction hash</label><Input id="withdrawal-hash" value={withdrawalHash} placeholder="0x…" onChange={e => setWithdrawalHash(e.target.value)} />{withdrawal.data && <div className="bridge-receipt"><strong>{withdrawal.data.status.replaceAll("-", " ")}</strong><p>Withdrawal target contract: <code>{withdrawal.data.message.target}</code></p><Button disabled={pending || withdrawal.data.status !== "ready-to-prove"} onClick={() => void run("prove")}>Submit proof on settlement</Button><Button variant="outline" disabled={pending || withdrawal.data.status !== "ready-to-finalize"} onClick={() => void run("finalize")}>Finalize withdrawal</Button></div>}{withdrawal.isError && <p className="form-error" role="alert">{withdrawal.error.message}</p>}{error && <p className="form-error" role="alert">{error}</p>}{pending && <p role="status">Complete the wallet request; waiting for its confirmed receipt.</p>}
      {receipts.map(receipt => <div className="bridge-receipt" key={receipt.hash}><strong>Confirmed {receipt.label}</strong><p>{receipt.network} · block {receipt.block}</p>{receipt.explorer ? <a className="text-link" href={receipt.explorer + "/tx/" + receipt.hash} target="_blank" rel="noopener noreferrer">View receipt</a> : <code className="address-block">{receipt.hash}</code>}</div>)}</div></section><aside className="panel side-note"><h2>Read the bridge's own timing.</h2>{delays.data ? <p>Proof maturity: {String(delays.data[0])} seconds. Dispute-game finality delay: {String(delays.data[1])} seconds. A game must also resolve successfully before finalization.</p> : <p>{delays.isError ? "Bridge timing could not be read. Retry the connection before proceeding." : "Reading deployed waiting periods…"}</p>}<hr /><p>Deposits wait for rollup relay. Withdrawals require an initiation, a proof, and finalization after the deployed bridge's conditions are satisfied.</p><hr /><p>To move ETH between corporations, withdraw to settlement, then deposit to the destination chain. Proposal action batches remain atomic within their own chain.</p></aside></div></>;
}
