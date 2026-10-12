import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { Registry } from "../core/registry";
import { closeDatabases } from "../core/db";
import { closeJobs, DISCOVERY_QUEUE, DRIFT_QUEUE, enqueueDiscovery, jobs, processDiscovery, queueSchema, startDriftWorker, type DiscoveryTask } from "../core/jobs";

const url = process.env.CREAMA_SAFETY_TEST_URL;
const suite = url ? describe : describe.skip;
const schema = `queue_${randomUUID().replaceAll("-", "")}`;
let reg: Registry;
const admin = new pg.Pool({ connectionString: url });
afterAll(async () => {
  await closeJobs(); await closeDatabases();
  if (url) { await admin.query(`DROP SCHEMA IF EXISTS ${queueSchema({ opts: { schema } } as Registry)} CASCADE`); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  await admin.end();
});

suite("persistent discovery", () => {
  it("enqueues atomically once, survives a producer restart and retries interrupted work", async () => {
    reg = new Registry(url, { schema });
    const source = await reg.addSource("default", { slug: "test", name: "Test", kind: "external", connection: "unused" }, "test");
    const input = { workspaceId: "default", sourceId: source.id, hint: null, focus: null, model: "fixture", actor: "test" };
    const ids = await Promise.all([enqueueDiscovery(reg, input), enqueueDiscovery(reg, input)]);
    expect(ids[0]).toBe(ids[1]);
    let boss = await jobs(reg);
    const child = fork("test/queue-claim.ts", { execArgv: ["--import", "tsx"], env: { ...process.env, CREAMA_QUEUE_TEST_SCHEMA: schema }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const first = await new Promise<Awaited<ReturnType<typeof boss.fetch<DiscoveryTask>>>[number]>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claim subprocess timed out")); }, 8000);
      child.once("message", (message) => { clearTimeout(timer); resolve(message as any); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { if (code) { clearTimeout(timer); reject(new Error(`Claim subprocess exited ${code}`)); } });
    });
    expect(first.data.runId).toBe(ids[0]);
    // Actual process death after claiming work, without fail/complete acknowledgement.
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
    await closeJobs();
    await reg.failStaleRuns("restart");
    expect((await reg.run(source.id, ids[0]))!.status).toBe("running");
    // Move just this disposable test attempt beyond its heartbeat window. Real crashes wait for it.
    await admin.query(`UPDATE ${queueSchema(reg)}.job SET heartbeat_on = now() - interval '2 minutes', started_on = now() - interval '2 minutes' WHERE id = $1`, [first.id]);
    boss = await jobs(reg);
    await boss.supervise(DISCOVERY_QUEUE);
    await admin.query(`UPDATE ${queueSchema(reg)}.job SET start_after = now() - interval '1 second' WHERE id = $1`, [first.id]);
    const [retry] = await boss.fetch<DiscoveryTask>(DISCOVERY_QUEUE, { includeMetadata: true });
    expect(retry).toBeDefined(); expect(retry.retryCount).toBeGreaterThan(0);
    let executions = 0;
    const execute = async () => { executions++; };
    await processDiscovery(reg, retry, execute);
    await boss.complete(DISCOVERY_QUEUE, retry);
    expect((await reg.run(source.id, ids[0]))!.status).toBe("done");
    await processDiscovery(reg, retry, execute);
    expect(executions).toBe(1); // crash after results commit does not execute the model again
  }, 15000);

  it("persists the recurring drift schedule across worker restarts and can disable it", async () => {
    await startDriftWorker(reg, "0 * * * *");
    await closeJobs();
    const boss = await jobs(reg);
    expect(await boss.getSchedule(DRIFT_QUEUE)).toMatchObject({ cron: "0 * * * *" });
    await startDriftWorker(reg, "off");
    expect(await boss.getSchedule(DRIFT_QUEUE)).toBeNull();
  });

  it("rolls back the run record when enqueue fails", async () => {
    const source = (await reg.sources("default"))[0];
    const boss = await jobs(reg);
    await boss.deleteQueue(DISCOVERY_QUEUE);
    await expect(enqueueDiscovery(reg, { workspaceId: "default", sourceId: source.id, hint: null, focus: null, model: "fixture", actor: "test" })).rejects.toThrow();
    expect((await reg.latestRun(source.id))!.status).toBe("done");
  });
});
