"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus, ArrowRight, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ledger, type Community, type PageResponse } from "@/lib/community";
import VerifiedLogo from "./verified-logo";
export default function BlocksharesDirectory() {
  const [cursor, setCursor] = useState<string | null>(null);
  const page = useQuery({ queryKey: ["blockshares", cursor], queryFn: () => ledger<PageResponse<Community>>("communities?limit=20" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "")), refetchInterval: 15000 });
  const corporations = page.data?.items.filter(item => item.kind === "blockshares") ?? [];
  return <><div className="page-heading"><div><p className="eyebrow">TERRA / BLOCKSHARES</p><h1>Independent chains. Shared principles.</h1><p className="lede">Corporations created by citizens, governed equally by stockholders.</p></div><Button asChild><Link href="/blockshares/new"><Plus size={17} />Propose a corporation</Link></Button></div>
    <section className="blockshares-intro panel"><Building2 size={35} /><div><h2>A corporation with its own assembly.</h2><p>Each approved Blockshare has an independent blockchain, permanent stockholders, and a treasury controlled through resolutions. Any wallet can join for 0.001 test ETH. One stockholder, one vote.</p><p className="small-note">Terra approves creation. A disclosed operator provisions the network and attests its deployment. Hosting is funded separately from the treasuries.</p></div></section>
    {page.isError && <p className="notice warning" role="alert">The directory service is unavailable. <Button variant="link" onClick={() => void page.refetch()}>Retry</Button></p>}
    <section className="corporation-grid" aria-label="Blockshares corporations">{corporations.map(item => <Link href={"/blockshares/" + item.id} className="panel corporation-card" key={item.id}><VerifiedLogo hash={item.logoHash} name={item.name} /><span className={"status status-" + (item.status?.toLowerCase() || "approved")}>{item.status || "Approved"}</span><h2>{item.name}</h2><p><Globe2 size={14} />Chain {item.chainId}</p><span className="text-link">Open corporation <ArrowRight size={15} /></span></Link>)}</section>
    {!corporations.length && !page.isError && <section className="panel empty-state"><Building2 size={42} /><h2>{page.isLoading ? "Reading approved corporations…" : "The first corporation starts with a vote."}</h2><p>Publish a creation proposal with its name and logo. After approval, its blockchain will be provisioned.</p></section>}
    <div className="pagination-controls"><Button variant="outline" disabled={!cursor} onClick={() => setCursor(null)}>Newest</Button><span>20 organizations per page</span><Button variant="outline" disabled={!page.data?.nextCursor} onClick={() => setCursor(page.data?.nextCursor ?? null)}>Older</Button></div>
  </>;
}
