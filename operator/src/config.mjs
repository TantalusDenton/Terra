import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const operatorRoot = resolve(projectRoot, "operator");
export const stateRoot = resolve(operatorRoot, "state");
export const rollupsRoot = resolve(projectRoot, "infra/rollups");
export const operatorKeyPath = resolve(operatorRoot, "secrets/operator.dpapi");
export const manifestPath = resolve(projectRoot, "services/runtime/manifest.json");
export const networkSpecPath = resolve(operatorRoot, "network-spec.json");
export const jobsPath = resolve(stateRoot, "jobs.json");
export const rootNetworkPath = resolve(stateRoot, "networks/2151908/network.json");
