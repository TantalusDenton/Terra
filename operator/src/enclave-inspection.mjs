// A failed inspect does not establish that an enclave is absent. In particular,
// Kurtosis can print its identity/artifacts and then fail listing stale services.
export function parseEnclaveInspection(enclave, result) {
  if (result.code) {
    const diagnostic = `${result.stderr}\n${result.stdout}`;
    throw new Error(`Cannot safely inspect preserved enclave '${enclave}' (exit ${result.code}). No ledger was reset. ${diagnostic.slice(-1800)}`);
  }
  const rows = section => section.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(row => /^[0-9a-f]{12,32}$/.test(row[0]) && row[1]).map(row => row[1]);
  return {
    enclave,
    uuidPrefix: result.stdout.match(/^UUID:\s+([0-9a-f]{12,32})\s*$/m)?.[1],
    services: rows(result.stdout.split("User Services")[1] ?? ""),
    artifacts: rows(result.stdout.split("Files Artifacts")[1]?.split("User Services")[0] ?? ""),
    raw: result.stdout,
  };
}

export function assertLogsCollectorReady(uuidPrefix, result) {
  if (!/^[0-9a-f]{12,32}$/.test(uuidPrefix ?? "")) throw new Error("Cannot establish the preserved enclave identity for logs-collector preflight.");
  const identities = result.stdout?.trim().split(/\r?\n/).filter(Boolean) ?? [];
  if (result.code || identities.length !== 1 || !/^[0-9a-f]{32}$/.test(identities[0]) || !identities[0].startsWith(uuidPrefix)) {
    throw new Error("The preserved enclave's logs collector is not confirmed running. Restore its original collector before retrying; no services or ledgers were changed.");
  }
}
