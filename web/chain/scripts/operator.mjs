import { createProtectedSigner, loadProtectedSigner } from "./deployer.mjs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const loadOperator = () => loadProtectedSigner("operator");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "create") console.log(JSON.stringify(await createProtectedSigner("operator")));
  else if (process.argv[2] === "status") console.log(await readFile(new URL("../../.terra-secrets/operator-public.json", import.meta.url), "utf8"));
  else throw new Error("Use create or status. Signing keys stay protected by Windows DPAPI.");
}
