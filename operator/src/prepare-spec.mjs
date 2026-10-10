import { atomicJson } from "./storage.mjs";
import { networkSpecPath } from "./config.mjs";
import { publicNetworkSpecification } from "./spec.mjs";
await atomicJson(networkSpecPath, publicNetworkSpecification);
console.log(JSON.stringify({ path: networkSpecPath, chainSpecHash: publicNetworkSpecification.chainSpecHash }));
