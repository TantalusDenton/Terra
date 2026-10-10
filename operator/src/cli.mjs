import { resolve } from "node:path";
import { operatorKeyPath, stateRoot } from "./config.mjs";
import { createKey } from "./keys.mjs";
import { acquireProcessLock } from "./storage.mjs";
import { bootstrapRoot, discoverApproved, processNext } from "./provisioner.mjs";
import { setTimeout } from "node:timers/promises";

const command = process.argv[2];
if (command === "key:create") console.log(JSON.stringify(await createKey(operatorKeyPath)));
else if (command === "root:bootstrap") {
  const release = await acquireProcessLock(resolve(stateRoot, "operator.lock"));
  try { console.log(JSON.stringify(await bootstrapRoot())); } finally { await release(); }
}
else if (command === "once" || command === "watch") {
  const release = await acquireProcessLock(resolve(stateRoot, "operator.lock"));
  let quitting = false;
  process.on("SIGINT", () => { quitting = true; });
  process.on("SIGTERM", () => { quitting = true; });
  try {
    do {
      try { await discoverApproved(); await processNext(); }
      catch (error) { console.error(JSON.stringify({ at: new Date().toISOString(), error: error.message })); if (command === "once") throw error; }
      if (command === "once" || quitting) break;
      await setTimeout(5000);
    } while (!quitting);
  } finally { await release(); }
} else throw new Error("Use key:create, root:bootstrap, once, or watch.");
