import { fileURLToPath } from "node:url";
import { prepareClientConfig } from "./prepare-client-config.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["build", "start"].includes(command)) throw new Error("Expected build or start.");
process.env.TERRA_WEB_RUNTIME = "node";
await prepareClientConfig();
const cli = new URL("../node_modules/vinext/dist/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(command === "start" ? ["--hostname", "127.0.0.1"] : []), ...args];
await import(cli.href);
