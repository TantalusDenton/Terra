import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export function captureTail(previous, chunk, limit = 1024 * 1024) {
  return (previous + chunk).slice(-limit);
}

export async function run(command, args, { cwd, logPath, env = {}, timeout = 0, allowFailure = false, captureLimit = 1024 * 1024 } = {}) {
  let handle;
  if (logPath) { await mkdir(dirname(logPath), { recursive: true }); handle = await open(logPath, "a"); }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timer;
      if (timeout) timer = setTimeout(() => { child.kill(); reject(new Error(`Command exceeded ${timeout}ms: ${command}`)); }, timeout);
      child.stdout.on("data", (chunk) => { stdout = captureTail(stdout, chunk.toString(), captureLimit); handle?.write(chunk).catch(() => {}); });
      child.stderr.on("data", (chunk) => { stderr = captureTail(stderr, chunk.toString(), captureLimit); handle?.write(chunk).catch(() => {}); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (code && !allowFailure) reject(new Error(`Command failed (${code}): ${command}. ${stderr.slice(-1500)} ${stdout.slice(-500)}`));
        else resolve({ code, stdout, stderr });
      });
    });
  } finally { await handle?.close(); }
}
