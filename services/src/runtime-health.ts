export function failureReporter(log: (message: string) => void, clock = Date.now) {
  const seen = new Map<string, { message: string; at: number }>();
  return (key: string, error: unknown) => {
    if (error === null) { seen.delete(key); return; }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1200);
    const previous = seen.get(key); const now = clock();
    if (previous?.message === message && now - previous.at < 60_000) return;
    if (!seen.has(key) && seen.size >= 512) seen.delete(seen.keys().next().value!);
    seen.set(key, { message, at: now });
    log(`[${key}] ${message}`);
  };
}
