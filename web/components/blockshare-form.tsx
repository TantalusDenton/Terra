"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { decodeEventLog, encodeFunctionData, keccak256, type Hex } from "viem";
import { useTerra } from "@/app/providers";
import { ledger, protocolAbis } from "@/lib/community";
import { validateDraft, emptyDraft } from "@/lib/proposals";
import { userError } from "@/lib/terra";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { WalletControl } from "./terra-shell";
import VerifiedLogo from "./verified-logo";
type NetworkSpec = { governanceVersion: number; chainSpecHash: Hex; description: string; settlementChainId: string };
type Logo = { hash: Hex; uri: string; width: number; height: number };
export default function BlockshareForm() {
  const { community, chain, account, citizen, governorAbi, governorAddress, publicClient, busy, transact } = useTerra();
  const { signMessageAsync } = useSignMessage(); const router = useRouter();
  const spec = useQuery({ queryKey: ["network-spec", community.chainId], queryFn: () => ledger<NetworkSpec>("network-spec"), retry: 1 });
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [duration, setDuration] = useState("72");
  const [chainId, setChainId] = useState("5210001"); const [logo, setLogo] = useState<Logo | null>(null); const [uploading, setUploading] = useState(false);
  const [review, setReview] = useState<ReturnType<typeof validateDraft> | null>(null); const [error, setError] = useState("");
  async function upload(file: File) {
    setError(""); setReview(null);
    if (!account.address || !citizen.data?.id) { setError("Connect an enrolled Terra citizen wallet before uploading its proposal logo."); return; }
    if (file.size > 2 * 1024 * 1024) { setError("Choose a PNG, JPEG, or WebP no larger than 2 MiB."); return; }
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); const hash = keccak256(bytes);
      const message = "Terra logo upload\nChain: " + community.chainId + "\nRegistry: " + community.registry.toLowerCase() + "\nWallet: " + account.address.toLowerCase() + "\nHash: " + hash + "\nIssuedAt: " + Math.floor(Date.now()/1000);
      const signature = await signMessageAsync({ message });
      const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(message))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const result = await ledger<Logo>("logos", { method: "POST", body: bytes, headers: { "content-type": file.type, "x-terra-wallet": account.address, "x-terra-signature": signature, "x-terra-message": encoded } });
      if (result.hash !== hash) throw new Error("The stored image does not match the approved bytes.");
      setLogo(result);
    } catch (e) { setError(e instanceof Error ? e.message : "Logo upload failed."); } finally { setUploading(false); }
  }
  async function prepare() {
    setError(""); setReview(null);
    try {
      if (community.kind !== "terra" || !community.directory) throw new Error("The Terra Blockshares directory is not deployed on this profile yet.");
      if (!name.trim() || new TextEncoder().encode(name).length > 128) throw new Error("Choose a corporation name of 1–128 UTF-8 bytes.");
      if (!logo || !spec.data) throw new Error("Upload a logo and wait for the operator's supported network specification.");
      if (!/^[1-9]\d{0,9}$/.test(chainId) || Number(chainId) > 2147483647 || chainId === community.chainId || chainId === spec.data.settlementChainId) throw new Error("Choose an unused chain ID between 1 and 2,147,483,647, different from Terra and settlement.");
      const registered = await publicClient.readContract({ address: community.directory, abi: protocolAbis.blocksharesDirectory, functionName: "chainRequestId", args: [BigInt(chainId)] });
      if (registered !== 0n) throw new Error("That chain ID is already approved. Choose another.");
      const metadata = { name, logoURI: logo.uri, logoHash: logo.hash, chainId: BigInt(chainId), governanceVersion: spec.data.governanceVersion, chainSpecHash: spec.data.chainSpecHash };
      const data = encodeFunctionData({ abi: protocolAbis.blocksharesDirectory, functionName: "requestCreation", args: [metadata] });
      setReview(validateDraft({ ...emptyDraft(), title: "Create Blockshare: " + name, summary: description,
        body: "Create the Blockshares corporation “" + name + "” with its own OP Stack rollup, permanent stockholders, independent treasury, and equal one-wallet/one-vote governance.\n\n" + description + "\n\nApproved logo URI: " + logo.uri + "\nLogo content hash: " + logo.hash + "\nChain ID: " + chainId + "\nNetwork specification hash: " + spec.data.chainSpecHash + "\nGovernance version: " + spec.data.governanceVersion + "\n\nThe project operator funds infrastructure, provisions the approved network, and attests its deployment. Enrollment is open to any wallet for exactly 0.001 test ETH into that corporation's treasury. Voting and joining transaction fees are paid by the signing wallet.",
        duration, unit: "hours", actions: [{ target: community.directory, value: "0", data }] }));
    } catch (e) { setError(e instanceof Error ? e.message : "Creation proposal could not be prepared."); }
  }
  async function publish() {
    if (!review) return; setError("");
    try {
      const receipt = await transact("Blockshare creation proposal published", governorAddress, governorAbi, "propose", [review.title, review.summary, review.body, review.duration, review.actions]);
      const confirmed = await publicClient.getTransactionReceipt({ hash: receipt.hash }); let proposalId: bigint | null = null;
      for (const log of confirmed.logs) { if (log.address.toLowerCase() !== governorAddress.toLowerCase()) continue; try { const parsed = decodeEventLog({ abi: governorAbi, data: log.data, topics: log.topics }); if (parsed.eventName === "ProposalCreated") proposalId = (parsed.args as unknown as { proposalId: bigint }).proposalId; } catch {} }
      router.push(proposalId ? "/proposals/" + proposalId : "/");
    } catch (e) { setError(userError(e)); }
  }
  return <><Link href="/blockshares" className="back-link">Blockshares / Create</Link><div className="page-heading"><div><p className="eyebrow">A TERRA GOVERNANCE PROPOSAL</p><h1>Propose a corporation.</h1><p className="lede">Citizens vote on its name, logo, and exact network specification.</p></div></div>
    <div className="assembly-layout"><section className="panel"><form className="panel-body proposal-form" onSubmit={e => { e.preventDefault(); void prepare(); }}>
      <label className="field-label" htmlFor="corporation-name">Corporation name</label><Input id="corporation-name" required value={name} onChange={e => { setName(e.target.value); setReview(null); }} />
      <label className="field-label" htmlFor="corporation-description">Purpose and proposed activities</label><Textarea id="corporation-description" rows={5} value={description} onChange={e => { setDescription(e.target.value); setReview(null); }} />
      <label className="field-label" htmlFor="corporation-logo">Approved logo</label><Input id="corporation-logo" type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file); }} /><p className="small-note">PNG, JPEG, or WebP · 2 MiB maximum · 4096 pixels maximum. Upload requires a wallet-control signature, without a blockchain transaction.</p>{logo && <div className="uploaded-logo"><VerifiedLogo hash={logo.hash} name={name || "Corporation"} /><code>{logo.hash}</code></div>}
      <label className="field-label" htmlFor="corporation-chain">Unique chain ID</label><div className="inline-form"><Input id="corporation-chain" value={chainId} inputMode="numeric" onChange={e => { setChainId(e.target.value); setReview(null); }} /><Button type="button" variant="outline" onClick={() => { const numbers = crypto.getRandomValues(new Uint32Array(1)); setChainId(String(5000000 + numbers[0] % 1000000000)); setReview(null); }}>Generate</Button></div>
      <label className="field-label" htmlFor="creation-duration">Voting duration in hours</label><Input id="creation-duration" required type="number" min="1" max="720" value={duration} onChange={e => { setDuration(e.target.value); setReview(null); }} />
      <div className="notice"><p>{spec.data?.description || (spec.isError ? "Start the rollup operator to publish its supported network specification." : "Loading the supported network specification…")}</p></div>
      {error && <p className="form-error" role="alert">{error}</p>}{!review ? <Button type="submit" disabled={uploading || !spec.data}>Review exact creation proposal</Button> : <section className="review-box"><h2>{review.title}</h2><p className="policy-text">{review.body}</p><pre>{JSON.stringify(review.actions, (_, v) => typeof v === "bigint" ? v.toString() : v, 2)}</pre>{!account.address ? <WalletControl /> : !citizen.data?.id ? <Button asChild variant="outline"><Link href="/citizenship">Become a citizen first</Link></Button> : <Button type="button" disabled={busy || account.chainId !== chain.id} onClick={() => void publish()}>Publish with wallet</Button>}</section>}
    </form></section><aside className="panel side-note"><h2>Approval starts the process.</h2><p>After this policy passes and is executed, the operator provisions a separate blockchain. Its approved branding cannot be changed.</p><hr /><h3>Open stockholding</h3><p>Each wallet enrolls independently for 0.001 test ETH. Membership is permanent and gives one vote, with no additional weight for wealth.</p><hr /><h3>Independent funds</h3><p>This creation action spends no Terra treasury funds. Infrastructure is paid for by the project operator.</p></aside></div>
  </>;
}
