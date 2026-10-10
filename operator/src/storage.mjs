import { mkdir, readFile, rename, writeFile, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const serialize = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";

export async function readJson(path, fallback = undefined) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

export async function atomicJson(path, value) {
  return atomicText(path, serialize(value));
}

export async function atomicText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.next`;
  const handle = await open(temporary, "w");
  try { await handle.writeFile(value); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}

export async function acquireProcessLock(path) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, serialize({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = await readJson(path);
    let running = false;
    try { process.kill(previous.pid, 0); running = true; } catch (signalError) { if (signalError.code !== "ESRCH") throw signalError; }
    if (running) throw new Error(`Operator already running (PID ${previous.pid}).`);
    await rm(path);
    return acquireProcessLock(path);
  }
  return async () => { await rm(path, { force: true }); };
}
