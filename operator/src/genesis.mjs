export function frozenGenesisTimestamp(prior, archived, now = Date.now()) {
  let timestamp = prior?.genesisTimestamp;
  if (archived) {
    const original = Number(BigInt(archived.timestamp));
    if (timestamp !== undefined && timestamp !== original) throw new Error("Checkpoint and archived genesis timestamps differ.");
    timestamp = original;
  }
  if (timestamp === undefined && prior) throw new Error("Interrupted root startup has no frozen genesis timestamp. Archive its original genesis before retrying.");
  timestamp ??= Math.floor(now / 1000) + 60;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("Invalid frozen genesis timestamp.");
  return timestamp;
}

export function freezeRootTemplate(template, timestamp) {
  const matches = [...template.matchAll(/^    genesis_delay: \d+\r?$/gm)];
  if (matches.length !== 1 || /^    genesis_timestamp:/m.test(template)) throw new Error("Root network template must have exactly one unmodified genesis delay setting.");
  return template.replace(matches[0][0], match => `${match.trimEnd()}\n    genesis_timestamp: ${timestamp}`);
}

export function assertSameDockerEngine(expected, actual) {
  if (!expected?.trim() || expected.trim() !== actual?.trim()) throw new Error("WSL and Windows use different Docker engines. Enable Docker Desktop WSL integration for the selected distribution; the original ledger has not been recreated.");
}
