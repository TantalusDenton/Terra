import { spawnSync } from "node:child_process";
import { readFile, mkdir, rename, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("./", import.meta.url));
const git = process.env.TERRA_GIT ?? "git";
const optimism = resolve(root, "vendor/optimism-package");
const ethereum = resolve(optimism, "ethereum-package");
const pins = {
  optimism: "84cd0961fcce613558d7b260d8751a3ace533d31",
  ethereum: "83830d44823767af65eda7dfe6b26c87c536c4cf",
  prometheus: "f5ce159aec728898e3deb827f6b921f8ecfc527f",
  postgres: "2d363be1bc42524f6b0575cac0bbc0fd194ae173",
};
function command(args, cwd) {
  const result = spawnSync(git, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status) throw new Error(`Git package preparation failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trimEnd().replaceAll("\r\n", "\n");
}
async function checkout(path, repository, commit) {
  try { await stat(resolve(path, ".git")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(resolve(path, ".."), { recursive: true });
    command(["-c", "core.autocrlf=false", "clone", "--filter=blob:none", repository, path]);
    command(["checkout", "--detach", commit], path);
  }
  if (command(["rev-parse", "HEAD"], path) !== commit) throw new Error(`Preserved checkout ${path} has a different revision. No files were reset.`);
}
const hash = value => createHash("sha256").update(value).digest("hex");
const audit = [];
let normalizedTextFiles = 0;
async function normalizeText(path) {
  for (const file of command(["ls-files"], path).split("\n")) {
    if (!/\.(star|sh|py|ya?ml|tmpl|txt|json|toml|env|envrc|conf|cfg|ini|jq|js|md)$/.test(file) && !/(^|\/)Dockerfile$/.test(file)) continue;
    const target = resolve(path, file); const source = await readFile(target, "utf8");
    if (!source.includes("\r\n")) continue;
    // Pure line-ending normalization retains every semantic/local edit. Linux
    // shell/env templates cannot consume Git-for-Windows CRLF expansions.
    await writeFile(`${target}.terra-next`, source.replaceAll("\r\n", "\n"));
    await rename(`${target}.terra-next`, target); normalizedTextFiles++;
  }
}
async function patch(path, file, changes) {
  const original = command(["show", `HEAD:${file}`], path) + "\n";
  let patched = original;
  for (const [from, to, count = 1] of changes) {
    if (patched.split(from).length - 1 !== count) throw new Error(`Unexpected pinned source in ${file}.`);
    patched = patched.split(from).join(to);
  }
  const target = resolve(path, file);
  const existing = (await readFile(target, "utf8")).replaceAll("\r\n", "\n");
  const previousGenerated = original.replaceAll("github.com/ethpandaops/ethereum-package/", "github.com/ethpandaops/optimism-package/ethereum-package/");
  if (existing !== original && existing !== patched && existing !== previousGenerated) throw new Error(`Unrecognized edits in ${target}; they have been preserved.`);
  if (existing !== patched) {
    await writeFile(`${target}.terra-next`, patched);
    await rename(`${target}.terra-next`, target);
  }
  audit.push({ file: target.slice(root.length).replaceAll("\\", "/"), originalSha256: hash(original), patchedSha256: hash(patched) });
}

await checkout(optimism, "https://github.com/ethpandaops/optimism-package.git", pins.optimism);
await checkout(ethereum, "https://github.com/ethpandaops/ethereum-package.git", pins.ethereum);
// Embed the pinned dependency in the root package namespace. Kurtosis 1.20.0's
// local replace loader fails on both observed Windows and Linux clients. All
// changes remain mechanically generated against the exact upstream preimage.
const originalLocator = "github.com/ethpandaops/ethereum-package/";
const embeddedLocator = "/ethereum-package/";
for (const file of command(["ls-files", "*.star"], optimism).split("\n")) {
  const source = command(["show", `HEAD:${file}`], optimism);
  const count = source.split(originalLocator).length - 1;
  if (count) await patch(optimism, file, [[originalLocator, embeddedLocator, count]]);
}
await patch(ethereum, "src/static_files/static_files.star", [[
  'STATIC_FILES_DIRPATH = "/static_files"', 'STATIC_FILES_DIRPATH = "/ethereum-package/static_files"',
]]);
await patch(ethereum, "src/package_io/input_parser.star", [
  ['            genesis_delay=result["network_params"]["genesis_delay"],', '            genesis_delay=result["network_params"]["genesis_delay"],\n            genesis_timestamp=result["network_params"].get("genesis_timestamp", None),'],
  ['        "genesis_delay": 20,', '        "genesis_delay": 20,\n        "genesis_timestamp": None,', 2],
]);
await patch(ethereum, "src/package_io/sanity_check.star", [[
  '        "genesis_delay",', '        "genesis_delay",\n        "genesis_timestamp",',
]]);
await patch(ethereum, "src/network_launcher/kurtosis.star", [[
  `    final_genesis_timestamp = shared_utils.get_final_genesis_timestamp(
        plan,
        network_params.genesis_delay
        + CL_GENESIS_DATA_GENERATION_TIME
        + num_participants * CL_NODE_STARTUP_TIME,
    )`,
  `    # Terra compatibility patch: persistent networks must retain their original
    # EL and CL timestamp even if a failed startup causes instructions to rerun.
    if network_params.genesis_timestamp != None:
        if type(network_params.genesis_timestamp) != "int" or network_params.genesis_timestamp <= 0:
            fail("genesis_timestamp must be a positive integer Unix timestamp")
        final_genesis_timestamp = str(network_params.genesis_timestamp)
    else:
        final_genesis_timestamp = shared_utils.get_final_genesis_timestamp(
            plan,
            network_params.genesis_delay
            + CL_GENESIS_DATA_GENERATION_TIME
            + num_participants * CL_NODE_STARTUP_TIME,
        )`,
]]);
await patch(ethereum, "src/prelaunch_data_generator/el_cl_genesis/el_cl_genesis_generator.star", [
  ['genesis_values_and_dest_filepath, "genesis-el-cl-env-file"', 'genesis_values_and_dest_filepath, "genesis-el-cl-env-file-lf-v1"'],
  ['cp /opt/values.env /config/values.env', "tr -d '\\r' < /opt/values.env > /config/values.env"],
]);
// The archived minimal Deneb genesis commits the v7 32-element blob-list
// preset. v8's 4096-element preset cannot open it. Keep the failed v8 database
// intact, and let only this exact compatible binary initialize a versioned
// subdirectory inside the original beacon volume. The EL ledger is unchanged.
await patch(ethereum, "src/cl/lighthouse/lighthouse_launcher.star", [[
  '        "--datadir=" + BEACON_DATA_DIRPATH_ON_BEACON_SERVICE_CONTAINER,',
  '        "--datadir=" + BEACON_DATA_DIRPATH_ON_BEACON_SERVICE_CONTAINER + ("/terra-deneb-v7" if participant.cl_image == "sigp/lighthouse@sha256:870934e38931d1a0f6cf47ff976e246a08a4b5509b84ff585aa2233e76744aa8" else ""),',
]]);
await normalizeText(optimism);
await normalizeText(ethereum);
await mkdir(resolve(root, "runtime"), { recursive: true });
await writeFile(resolve(root, "runtime/package-lock.json"), JSON.stringify({ version: 1, pins, compatibilityPatch: "terra-embedded-frozen-genesis-v4", files: audit }, null, 2) + "\n");
console.log(JSON.stringify({ prepared: true, pins, compatibilityPatch: "terra-embedded-frozen-genesis-v4", files: audit.length, normalizedTextFiles }));
