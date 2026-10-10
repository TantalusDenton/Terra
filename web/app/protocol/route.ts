import deployment from "@/lib/deployment.json";
import interfaces from "@/lib/abis.json";

export async function GET() {
  let multichain = null;
  try { const response = await fetch((process.env.TERRA_LEDGER_API_URL || "http://127.0.0.1:5190/v1/").replace(/\/$/, "") + "/protocol", { signal: AbortSignal.timeout(5000) }); if (response.ok) multichain = await response.json(); } catch {}
  return Response.json(
    { protocol: "Terra", version: "0.2.0", deployment, multichain, interfaces },
    { headers: { "Cache-Control": "no-store" } },
  );
}
