// Persistent discovery queue. Enqueue and the run record commit together in Crema's state DB.
// Workers retry the whole discovery, not an in-flight Gemini request. No customer credentials
// or profile data go into queue payloads.
import { randomUUID } from "node:crypto";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { Registry } from "./registry";

export const DISCOVERY_QUEUE = "crema-discovery";
export const DRIFT_QUEUE = "crema-drift";
export const BRANCH_QUEUE = "crema-branch";
export type DiscoveryTask = { workspaceId: string; sourceId: number; runId: number; hint: string | null; focus: string | null };
export const discoveryPolicy = { retryLimit: 2, retryDelay: 10, retryBackoff: true, retryDelayMax: 60, expireInSeconds: 1800, heartbeatSeconds: 60 };
const runtimes: Map<string, Promise<PgBoss>> = ((globalThis as any).__cremaJobs ??= new Map());

export function queueSchema(reg: Registry) { return reg.opts.schema ? `${reg.opts.schema}_jobs` : "crema_jobs"; }

export async function jobs(reg: Registry): Promise<PgBoss> {
  await reg.db.ready;
  const url = reg.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for the discovery queue.");
  const key = `${url}#${queueSchema(reg)}`;
  let pending = runtimes.get(key);
  if (!pending) {
    pending = (async () => {
      const boss = new PgBoss({ connectionString: url, schema: queueSchema(reg), max: 3 });
      boss.on("error", (error) => console.error("[Crema queue]", error));
      try {
        await boss.start();
        await boss.createQueue(DISCOVERY_QUEUE, discoveryPolicy);
        await boss.createQueue(DRIFT_QUEUE, { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 900, heartbeatSeconds: 60 });
        // copying a branch: one retry (it restarts from an empty database), generous expiry for big copies
        await boss.createQueue(BRANCH_QUEUE, { retryLimit: 1, retryDelay: 30, expireInSeconds: 3600, heartbeatSeconds: 60 });
        return boss;
      } catch (error) { await boss.stop().catch(() => {}); throw error; }
    })();
    runtimes.set(key, pending);
    pending.catch(() => runtimes.delete(key));
  }
  return pending;
}

export async function enqueueDiscovery(reg: Registry, input: Omit<DiscoveryTask, "runId"> & { model: string; actor: string }) {
  const boss = await jobs(reg);
  return reg.tx(async (c) => {
    // Two requests for the same source produce one run/job, even on different app processes.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`crema.discovery:${input.sourceId}`]);
    const active = (await c.query("SELECT id FROM runs WHERE source_id = $1 AND status = 'running' ORDER BY id DESC LIMIT 1", [input.sourceId])).rows[0];
    if (active) return active.id as number;
    const jobId = randomUUID();
    const runId = (await c.query(`INSERT INTO runs (source_id, status, model, hint, focus, queue_job_id, steps)
      VALUES ($1, 'running', $2, $3, $4, $5, $6) RETURNING id`,
      [input.sourceId, input.model, input.hint, input.focus, jobId, JSON.stringify([{ at: new Date().toISOString(), kind: "step", text: "Queued for the discovery worker" }])])).rows[0].id as number;
    const task: DiscoveryTask = { workspaceId: input.workspaceId, sourceId: input.sourceId, runId, hint: input.hint, focus: input.focus };
    const sent = await boss.send(DISCOVERY_QUEUE, task, { ...discoveryPolicy, id: jobId, db: { executeSql: (text, values) => c.query(text, values) } });
    if (!sent) throw new Error("Discovery could not be queued.");
    await reg.event({ workspaceId: input.workspaceId, sourceId: input.sourceId }, input.actor, "discovery.queued", `run:${runId}`, { jobId, focus: input.focus }, c);
    return runId;
  });
}

/** Injected execution makes recovery tests deterministic: they never call a paid model. */
export async function startDiscoveryWorker(reg: Registry, execute?: (task: DiscoveryTask) => Promise<void>) {
  const boss = await jobs(reg);
  const perform = execute ?? (async (task: DiscoveryTask) => {
    const { Crema } = await import("./service");
    const svc = await new Crema(reg, { workspaceId: task.workspaceId, source: null }).withSource(task.sourceId);
    await svc.discover(task.runId, { hint: task.hint, focus: task.focus });
  });
  const options = { batchSize: 1, localConcurrency: 1, includeMetadata: true, pollingIntervalSeconds: 1 } as const;
  await boss.work<DiscoveryTask, void, typeof options>(DISCOVERY_QUEUE, options, async (batch) => {
    for (const task of batch) await processDiscovery(reg, task, perform);
  });
  return boss;
}

/** A crash on the final attempt cannot run its catch block: reconcile terminal queue state. */
export async function reconcileRun(reg: Registry, sourceId: number, runId: number) {
  const row = (await reg.db.pool.query("SELECT queue_job_id FROM runs WHERE id = $1 AND source_id = $2 AND status = 'running'", [runId, sourceId])).rows[0];
  if (!row?.queue_job_id) return;
  const boss = await jobs(reg);
  const job = await boss.getJobById(DISCOVERY_QUEUE, row.queue_job_id);
  if (!job || job.state === "failed" || job.state === "cancelled") {
    await reg.db.pool.query("UPDATE runs SET status = 'failed', finished_at = now(), error = $1 WHERE id = $2 AND source_id = $3 AND status = 'running'", ["Discovery queue exhausted retries, was cancelled or expired. Start a new discovery.", runId, sourceId]);
  }
}

export async function processDiscovery(reg: Registry, job: JobWithMetadata<DiscoveryTask>, execute: (task: DiscoveryTask) => Promise<void>) {
  const task = job.data;
  const lock = await reg.db.pool.connect();
  let acquired = false;
  try {
    acquired = (await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [`crema.run:${task.runId}`])).rows[0].ok;
    if (!acquired) throw new Error("Another worker still owns this discovery run.");
    const run = await reg.run(task.sourceId, task.runId);
    if (!run) throw new Error("Discovery run was not found on its original source.");
    if (run.status === "done") return; // crash after saving results but before queue acknowledgement
    await reg.updateRun(task.runId, { status: "running", error: "" });
    await reg.appendStep(task.runId, { kind: "detail", text: `Worker attempt ${job.retryCount + 1}; interrupted attempts restart discovery.` });
    try {
      await execute(task);
      await reg.updateRun(task.runId, { status: "done" });
    } catch (error) {
      const message = (error as Error).message;
      await reg.appendStep(task.runId, { kind: "error", text: job.retryCount < job.retryLimit ? `${message} — queued for retry` : message });
      if (job.retryCount >= job.retryLimit) await reg.updateRun(task.runId, { status: "failed", error: message });
      throw error;
    }
  } finally {
    if (acquired) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [`crema.run:${task.runId}`]).catch(() => {});
    lock.release();
  }
}

export async function closeJobs() {
  const all = [...runtimes.values()]; runtimes.clear();
  await Promise.all(all.map(async (pending) => { const boss = await pending.catch(() => null); await boss?.stop({ graceful: true, timeout: 5000 }); }));
}

/** One durable hourly schedule for the current single-workspace UI. Set 'off' to disable. */
export async function startDriftWorker(reg: Registry, cron = process.env.CREMA_DRIFT_CRON ?? "0 * * * *") {
  const boss = await jobs(reg);
  if (cron === "off") { await boss.unschedule(DRIFT_QUEUE); return; }
  await boss.schedule(DRIFT_QUEUE, cron, { workspaceId: "default" });
  await boss.work<{ workspaceId: string }>(DRIFT_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async (batch) => {
    const { Crema } = await import("./service");
    for (const job of batch) {
      const result = await new Crema(reg, { workspaceId: job.data.workspaceId, source: null }).checkDrift();
      if (result.errors.length) throw new Error(`Drift checks failed for ${result.errors.length} source(s); see audit.`);
    }
  });
}

export type BranchTask = { workspaceId: string; sourceId: number; operationId?: string };

/** The one advisory-lock key that copy, reset and delete of a branch (or a main's create-branch) share. */
export const branchLockKey = (reg: Registry, sourceId: number) => `crema.branch:${reg.opts.schema ?? "public"}:${sourceId}`;

/** Queue a branch copy; the source row already says "provisioning". */
export async function enqueueBranchCopy(reg: Registry, task: BranchTask, actor = "crema", action = "branch.reset", copy?: "data" | "schema") {
  const boss = await jobs(reg);
  return reg.tx(async (c) => {
    const lock = await c.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [branchLockKey(reg, task.sourceId)]);
    if (!lock.rows[0].ok) throw new Error("This branch is being copied or deleted. Try again after it finishes.");
    const row = (await c.query("SELECT * FROM sources WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE", [task.sourceId, task.workspaceId])).rows[0];
    if (!row?.parent_id) throw new Error("Only a live branch can be copied.");
    if (row.status === "provisioning" && row.branch_job_id) {
      const active = await boss.getJobById(BRANCH_QUEUE, row.branch_job_id);
      if (active && !["failed", "cancelled", "completed"].includes(active.state)) throw new Error("This branch is already being copied.");
    }
    const operationId = randomUUID();
    await c.query("UPDATE sources SET status = 'provisioning', error = NULL, branch_job_id = $2, branch_copy = coalesce($3, branch_copy, 'data') WHERE id = $1", [task.sourceId, operationId, copy ?? null]);
    const sent = await boss.send(BRANCH_QUEUE, { ...task, operationId }, { id: operationId, db: { executeSql: (text, values) => c.query(text, values) } });
    if (!sent) throw new Error("Branch copy could not be queued.");
    await reg.event({ workspaceId: task.workspaceId, sourceId: task.sourceId }, actor, action, `source:${row.slug}`, { operationId, branch: row.branch }, c);
    return sent;
  });
}

export async function startBranchWorker(reg: Registry) {
  const boss = await jobs(reg);
  await boss.work<BranchTask>(BRANCH_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async (batch) => {
    const { Crema } = await import("./service");
    for (const job of batch) await new Crema(reg, { workspaceId: job.data.workspaceId, source: null }).copyBranch(job.data.sourceId, job.data.operationId, true);
  });
}
