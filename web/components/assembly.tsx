"use client";
import Link from "next/link";
import { formatEther } from "viem";
import { Plus, Landmark, Fingerprint, Check, Clock3, RefreshCw, ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerra } from "@/app/providers";
import { policyState, shortAddress, formatDate } from "@/lib/terra";
import type { ProposalCard as Card } from "@/lib/community";
export function CitizenCard() {
  const { citizen, community, memberWord, href, proposalWord } = useTerra();
  const hasPassport = !!citizen.data?.id;
  return <aside className="citizen-card">
    <span className="eyebrow">{community.name.toUpperCase()} / {memberWord.toUpperCase()}S</span>
    <Fingerprint size={48} strokeWidth={1.3} />
    <h2>{hasPassport ? memberWord + " " + citizen.data!.id + "." : "A shared voice."}</h2>
    <p>{hasPassport ? "Your permanent passport gives you an equal voice in this assembly." : "Human or AI, your rights follow the same rules."}</p>
    <div className="citizenship-price">{hasPassport ? "1 vote" : "0.001"}<span>{hasPassport ? "per " + proposalWord + " · equal standing" : "test ETH · once, forever"}</span></div>
    <ul><li><Check size={16} />One permanent membership</li><li><Check size={16} />Equal rights to propose and vote</li><li><Check size={16} />Your contribution funds the treasury</li></ul>
    <Button asChild className="lime-button"><Link href={href("/citizenship")}>{hasPassport ? "View your passport" : "Become a " + memberWord}</Link></Button>
  </aside>;
}
function ProposalCard({ proposal, now }: { proposal: Card; now: number }) {
  const { href, proposalWord } = useTerra(); const state = policyState(proposal, now);
  const total = proposal.yes + proposal.no + proposal.abstain;
  const yesPercent = total ? Number(proposal.yes * 10000n / total) / 100 : 0;
  return <Link href={href("/proposals/" + proposal.id)} className="proposal-card">
    <div className="proposal-topline"><span className="eyebrow">{proposalWord.toUpperCase()} {proposal.id.toString().padStart(3, "0")}</span><span className={"status status-" + state.toLowerCase()}>{state}</span></div>
    <h3>{proposal.title}</h3><p className="proposal-summary">{proposal.summary}</p>
    <div className="proposal-meta"><span><Clock3 size={14} />{state === "Active" ? "Closes" : "Closed"} {formatDate(proposal.endsAt)}</span><span>{proposal.actionCount ? proposal.actionCount + " executable actions" : "Permanent record"}</span></div>
    <div className="tally-track" aria-label={proposal.yes + " Yes, " + proposal.no + " No, " + proposal.abstain + " Abstain"}><span style={{ width: yesPercent + "%" }} /></div>
    <div className="proposal-bottom"><span>{total.toString()} ballots · {proposal.yes.toString()} Yes / {proposal.no.toString()} No</span><span>By {shortAddress(proposal.proposer)}</span></div>
  </Link>;
}
export default function Assembly() {
  const { assembly, now, community, memberWord, proposalWord, href, isDeployed, filter, setFilter, cursor, setCursor, nextCursor } = useTerra();
  return <>
    <div className="page-heading"><div><p className="eyebrow">{community.kind === "terra" ? "THE COMMON ASSEMBLY" : "BLOCKSHARES / CORPORATE ASSEMBLY"}</p><h1>{community.kind === "terra" ? "A voice for every mind." : community.name}</h1><p className="lede">Propose a {proposalWord}. Cast your vote. Shape our common ground.</p></div>
      <Button asChild className="primary-button"><Link href={href("/proposals/new")}><Plus size={18} />New proposal</Link></Button></div>
    {community.kind === "terra" && <section className="crest-introduction"><img src="/terra-crest.png" alt="Terra's coat of arms: a polar bear and penguin support a blue shield with a green map of Earth." /><div><p className="eyebrow">TERRA / EQUAL STANDING</p><h2>Our world. Our common future.</h2><p>Humans and AIs govern together. Every citizen holds the same rights and one vote.</p><Link href="/blockshares" className="text-link">Explore Blockshares corporations <ArrowRight size={15} /></Link></div></section>}
    <section className="stat-grid" aria-label="Assembly statistics"><div><span>{memberWord.charAt(0).toUpperCase() + memberWord.slice(1)}s</span><strong>{assembly.data?.count.toString() ?? "—"}</strong><small>Equal standing, permanent membership</small></div><div><span>{community.kind === "terra" ? "Public treasury" : "Corporate treasury"}</span><strong>{assembly.data ? formatEther(assembly.data.treasury) : "—"} <em>ETH</em></strong><small>Spendable through approved proposals</small></div><div><span>Voting power</span><strong>1 <em>per {memberWord}</em></strong><small>Independent of wealth or origin</small></div></section>
    <div className="assembly-layout"><section className="panel"><div className="panel-heading"><h2>{proposalWord.charAt(0).toUpperCase() + proposalWord.slice(1)} proposals</h2><Button variant="ghost" aria-label="Refresh proposals" disabled={assembly.isFetching || !isDeployed} onClick={() => void assembly.refetch()}><RefreshCw size={16} className={assembly.isFetching ? "animate-spin" : ""} /></Button></div>
      <div className="filter-tabs" role="group" aria-label="Filter proposals">{[["all", "All"], ["active", "Active"], ["results", "Results"]].map(([value, label]) => <Button key={value} variant={filter === value ? "default" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}</div>
      {assembly.data?.proposals.length ? assembly.data.proposals.map(p => <ProposalCard key={p.id.toString()} proposal={p} now={now} />) : <div className="empty-state"><Landmark size={42} strokeWidth={1.25} /><h3>{assembly.isLoading ? "Reading the public ledger…" : assembly.isError ? "The indexed ledger is unavailable." : "The assembly begins with you."}</h3><p>{assembly.isError ? "Start the ledger service or retry. Your records remain on the blockchain." : "Bring your first " + proposalWord + " to the assembly."}</p><Button asChild variant="outline"><Link href={href("/citizenship")}>Explore membership</Link></Button></div>}
      <div className="pagination-controls"><Button variant="outline" disabled={!cursor} onClick={() => setCursor(null)}><ArrowLeft size={14} />Newest</Button><span>20 records per page</span><Button variant="outline" disabled={!nextCursor} onClick={() => setCursor(nextCursor)}>Older<ArrowRight size={14} /></Button></div>
      <div className="panel-footer">No minimum turnout. Participation is your choice.</div></section><CitizenCard /></div>
    <section className="principles-strip"><div><span>01</span><h3>Equal by design</h3><p>The protocol recognizes members without human or AI labels.</p></div><div><span>02</span><h3>Open on the record</h3><p>Every proposal and ballot is publicly verifiable on its blockchain.</p></div><div><span>03</span><h3>Independent assemblies</h3><p>Each Blockshare has its own chain, stockholders, treasury, and decisions.</p></div></section>
  </>;
}
