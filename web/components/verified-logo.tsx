"use client";
import { useEffect, useState } from "react";
import { keccak256, type Hex } from "viem";
export default function VerifiedLogo({ hash, name }: { hash?: Hex; name: string }) {
  const [url, setUrl] = useState<string | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(null); setFailed(false);
    if (!hash) return;
    const controller = new AbortController(); let objectUrl: string | null = null;
    void fetch("/api/ledger/objects/" + hash, { signal: controller.signal }).then(async response => {
      if (!response.ok || !/^image\/(png|jpeg|webp)/.test(response.headers.get("content-type") || "")) throw new Error("Logo unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 2 * 1024 * 1024 || keccak256(bytes) !== hash) throw new Error("Logo integrity failed");
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: response.headers.get("content-type")! })); setUrl(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [hash]);
  return url ? <img className="corporation-logo" src={url} alt={name + " approved logo"} /> : <span className="corporation-logo logo-placeholder" aria-label={failed ? "Logo integrity or availability check failed" : "Logo loading"}>{name.charAt(0)}</span>;
}
