"use client";
import Assembly from "./assembly";
import { useTerra } from "@/app/providers";
import VerifiedLogo from "./verified-logo";
import { Button } from "./ui/button";
import Link from "next/link";
export default function BlockshareOverview() {
  const { community, isDeployed, communityError, assembly } = useTerra();
  if (community.status === "Unavailable") return <section className="panel empty-state"><h1>This creation request is unavailable.</h1><p>{communityError?.message || "Reading Terra's approved corporations…"} No deployment or approval is assumed without its record.</p><Button asChild variant="outline"><Link href="/blockshares">View Blockshares directory</Link></Button></section>;
  if (isDeployed) return <><div className="corporation-banner"><VerifiedLogo hash={community.logoHash} name={community.name} /><div><p className="eyebrow">INDEPENDENT OP STACK ROLLUP</p><p>Chain {community.chainId} · permanent stockholders · one wallet, one vote</p></div></div><Assembly /></>;
  return <section className="panel provisioning-panel"><VerifiedLogo hash={community.logoHash} name={community.name} /><p className="eyebrow">BLOCKSHARES / CREATION REQUEST {community.id}</p><h1>{community.name}</h1><ol className="deployment-steps">{["Approved", "Provisioning", "Active"].map(state => <li key={state} aria-current={community.status === state ? "step" : undefined}>{state}</li>)}</ol><p>{community.error || communityError?.message || "Terra approved this corporation. The operator is provisioning its independent blockchain; enrollment and voting open after the deployment is verified."}</p><p className="small-note">A completed approval transaction does not guarantee immediate network availability. Failed provisioning can be retried without changing the approved name, logo, or chain.</p><Button variant="outline" onClick={() => void assembly.refetch()}>Refresh status</Button></section>;
}
