import { notFound } from "next/navigation";
import ProposalDetail from "@/components/proposal-detail";
export default async function Page({ params }: { params: Promise<{ id: string; proposalId: string }> }) { const { id, proposalId } = await params; if (!/^[1-9]\d{0,77}$/.test(id) || !/^[1-9]\d{0,77}$/.test(proposalId)) notFound(); return <ProposalDetail id={proposalId} />; }
