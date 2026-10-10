import { notFound } from "next/navigation";
import ProposalDetail from "@/components/proposal-detail";

type Props = { params: Promise<{ id: string }> };
export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  return { title: `Policy ${id} — Terra` };
}
export default async function Page({ params }: Props) {
  const { id } = await params;
  if (!/^[1-9]\d{0,77}$/.test(id)) notFound();
  return <ProposalDetail id={id} />;
}
