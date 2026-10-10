import { atomicJson, readJson } from "./storage.mjs";

const stages = ["Approved", "Provisioning", "Verifying", "Activating", "Active"];
export class JobStore {
  constructor(path) { this.path = path; }
  async load() { return readJson(this.path, { schemaVersion: 1, jobs: {}, cursor: "0" }); }
  async save(state) { await atomicJson(this.path, { ...state, updatedAt: new Date().toISOString() }); }
  async enqueue(request, evidence) {
    const state = await this.load();
    const id = String(request.id);
    const current = state.jobs[id];
    if (current) {
      if (current.metadataHash !== request.metadataHash || current.chainId !== String(request.chainId)) throw new Error("Approved request changed while restoring a durable job.");
      return current;
    }
    if (Object.values(state.jobs).some((job) => job.chainId === String(request.chainId))) throw new Error("Another job already claims this chain ID.");
    const job = { ...request, id, chainId: String(request.chainId), status: "Approved", step: "network", attempts: 0, evidence, createdAt: new Date().toISOString(), events: [] };
    state.jobs[id] = job;
    await this.save(state);
    return job;
  }
  async update(id, patch) {
    const state = await this.load();
    const current = state.jobs[String(id)];
    if (!current) throw new Error("Unknown job.");
    if (patch.status && patch.status !== "Failed" && stages.indexOf(patch.status) < stages.indexOf(current.status) && current.status !== "Failed") throw new Error("A completed provisioning stage cannot be reset.");
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    next.events = [...current.events, { at: next.updatedAt, status: next.status, step: next.step }].slice(-100);
    state.jobs[String(id)] = next;
    await this.save(state);
    return next;
  }
  async next() {
    const state = await this.load();
    return Object.values(state.jobs).filter((job) => job.status !== "Active" && !job.retryAfter || job.status !== "Active" && Date.parse(job.retryAfter) < Date.now()).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)[0];
  }
}

// Each successful step is saved before the next operation. Restart continues the
// original chain and payload; a retry never creates a replacement request.
export async function advanceJob(store, job, adapters) {
  const steps = ["network", "governance", "verify", "activate", "publish"];
  try {
    for (let index = steps.indexOf(job.step); index < steps.length; index++) {
      const step = steps[index];
      const status = step === "network" || step === "governance" ? "Provisioning" : step === "verify" ? "Verifying" : "Activating";
      job = await store.update(job.id, { status, step, error: null, retryAfter: null });
      const outcome = await adapters[step](job);
      job = await store.update(job.id, { ...outcome, step: steps[index + 1] ?? "done" });
    }
    return store.update(job.id, { status: "Active", step: "done", error: null });
  } catch (error) {
    await store.update(job.id, { status: "Failed", error: String(error.message), attempts: job.attempts + 1, retryAfter: new Date(Date.now() + 60000).toISOString() });
    throw error;
  }
}
