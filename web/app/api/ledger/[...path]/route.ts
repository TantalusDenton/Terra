import { boundedBody, BodyTooLarge } from "@/lib/bounded-body";
const ledgerOrigin = process.env.TERRA_LEDGER_API_URL || "http://127.0.0.1:5190/v1/";
async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (!path.length || path.some(part => !/^[a-zA-Z0-9._:-]+$/.test(part) || part === "..")) return Response.json({ error: "Invalid ledger path." }, { status: 400 });
  if (request.method === "POST" && path.join("/") !== "logos") return Response.json({ error: "Unsupported operation." }, { status: 405 });
  const target = new URL(path.map(encodeURIComponent).join("/"), ledgerOrigin.endsWith("/") ? ledgerOrigin : ledgerOrigin + "/");
  target.search = new URL(request.url).search;
  const headers = new Headers();
  for (const name of ["content-type", "x-terra-wallet", "x-terra-signature", "x-terra-message"]) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  const max = 2 * 1024 * 1024;
  if (request.method === "POST" && Number(request.headers.get("content-length")) > max) return Response.json({ error: "Logo exceeds 2 MiB." }, { status: 413 });
  try {
    const body = request.method === "POST" ? await boundedBody(request, max) : undefined;
    const upstream = await fetch(target, { method: request.method, headers, body, signal: AbortSignal.timeout(20000) });
    const responseHeaders = new Headers();
    for (const name of ["content-type", "cache-control", "etag"]) { const value = upstream.headers.get(name); if (value) responseHeaders.set(name, value); }
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    if (error instanceof BodyTooLarge) return Response.json({ error: error.message }, { status: 413 });
    return Response.json({ error: "The local indexed-ledger service is unavailable. Start Terra services and retry." }, { status: 503 });
  }
}
export const GET = proxy;
export const POST = proxy;
