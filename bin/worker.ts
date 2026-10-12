#!/usr/bin/env -S npx tsx
// Run independently of Next.js. Deploy/restart web and worker without losing queued discovery.
import { existsSync } from "node:fs";
for (const file of [".env.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file);
const { Registry } = await import("../core/registry");
const { startDiscoveryWorker, startDriftWorker, closeJobs } = await import("../core/jobs");
const { closeDatabases } = await import("../core/db");
const { closePools } = await import("../core/warehouse");
const reg = new Registry();
await startDiscoveryWorker(reg);
await startDriftWorker(reg);
console.log("Creama discovery worker ready");
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await closeJobs(); await closePools(); await closeDatabases();
  process.exit(0);
}
process.on("SIGTERM", stop); process.on("SIGINT", stop);
