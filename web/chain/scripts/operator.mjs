import { createProtectedSigner, loadProtectedSigner } from "./deployer.mjs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { azureKeyVaultEnabled } from "../../../operator/src/signer-backend.mjs";

export const loadOperator = () => loadProtectedSigner("operator");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "create") console.log(JSON.stringify(await createProtectedSigner("operator")));
  else if (process.argv[2] === "status") console.log(azureKeyVaultEnabled()
    ? JSON.stringify({ address: (await loadOperator()).address, protection: "Azure Key Vault via VM managed identity" })
    : await readFile(new URL("../../.terra-secrets/operator-public.json", import.meta.url), "utf8"));
  else throw new Error("Use create or status. Signing keys stay in the configured protected backend.");
}
