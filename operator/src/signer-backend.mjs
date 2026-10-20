export function azureKeyVaultEnabled() {
  const backend = process.env.TERRA_SIGNER_BACKEND;
  if (backend && !["dpapi", "azure-key-vault"].includes(backend)) throw new Error("Unsupported signer backend.");
  return backend === "azure-key-vault";
}
