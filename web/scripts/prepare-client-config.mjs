import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Fresh checkouts have no private deployment state. Defaults keep transactions
// disabled; only deployment/verification tooling can supply real addresses.
export async function prepareClientConfig({ webRoot = fileURLToPath(new URL("../", import.meta.url)) } = {}) {
  const created = [];
  for (const [template, target] of [
    ["default-deployment.json", "lib/deployment.json"],
    ["default-rollup-anchor.json", "lib/rollup-anchor.json"],
    ["default-hosting.json", ".openai/hosting.json"],
  ]) {
    const destination = resolve(webRoot, target);
    await mkdir(dirname(destination), { recursive: true });
    const source = await readFile(new URL("../config/" + template, import.meta.url), "utf8");
    try {
      await writeFile(destination, source, { flag: "wx" });
      created.push(target);
    } catch (error) {
      // Existing deployments and trust anchors always take precedence. Do not
      // repair or replace an existing file as part of an ordinary app build.
      if (error.code !== "EEXIST") throw error;
    }
  }
  return created;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const created = await prepareClientConfig();
  if (created.length) console.log("Prepared undeployed client configuration: " + created.join(", "));
}
