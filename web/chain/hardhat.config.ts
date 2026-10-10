import { defineConfig } from "hardhat/config";
import toolbox from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [toolbox],
  solidity: { version: "0.8.35", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" } },
  networks: {
    hardhat: { type: "edr-simulated", chainType: "l1", chainId: 31337 },
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545", chainId: 31337 },
    baseSepolia: { type: "http", chainType: "op", url: process.env.TERRA_RPC_URL ?? "https://sepolia.base.org", chainId: 84532 },
  },
});
