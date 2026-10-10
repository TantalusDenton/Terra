import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { boundedBody, BodyTooLarge } from "../lib/bounded-body";

test("upload proxy bounds streamed bodies even without Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; },
  });
  const request = new Request("http://localhost/logos", { method: "POST", body, duplex: "half" } as RequestInit);
  await assert.rejects(boundedBody(request, 8), BodyTooLarge); assert.equal(cancelled, true);
});

test("upload proxy retains exact accepted bytes", async () => {
  const bytes = new Uint8Array([0, 128, 255, 1]);
  assert.deepEqual(await boundedBody(new Request("http://localhost/logos", { method: "POST", body: bytes }), 4), bytes);
});

test("corporate publication receipts never fall back to the legacy Terra RPC", async () => {
  const source = await readFile(new URL("../components/proposal-form.tsx", import.meta.url), "utf8");
  assert.match(source, /publicClient[^\n]+}= useTerra\(\)|publicClient[^\n]+} = useTerra\(\)/);
  assert.doesNotMatch(source, /(?:const|import)\s*\{[^}]*publicClient[^}]*\}[^;]*["']@\/lib\/terra["']/);
  assert.match(source, /log\.address\.toLowerCase\(\) !== governorAddress\.toLowerCase\(\)/);
});
