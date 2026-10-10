import { notFound } from "next/navigation";
import BlockshareOverview from "@/components/blockshare-overview";
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; if (!/^[1-9]\d{0,77}$/.test(id)) notFound(); return <BlockshareOverview />; }
