#!/usr/bin/env -S npx tsx
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalEnv } from "./env";

type Command = { name: string; command: string; args: string[] };
export function runGroup(commands: Command[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioOptions; oneShot?: boolean; graceMs?: number;
} = {}): Promise<number> {
  return new Promise(resolveResult => {
    const children: ChildProcess[] = [];
    let stopping = false, result = 0, pending = commands.length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = (child: ChildProcess, sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(sig);
        else process.kill(-child.pid, sig); // Include Next's descendants, not just its CLI.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("Could not stop dev child", (error as Error).message);
      }
    };
    const finish = () => {
      if (timer) clearTimeout(timer);
      // Kill descendants that outlived a gracefully exiting root process.
      for (const child of children) signal(child, "SIGKILL");
      process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
      resolveResult(result);
    };
    const stop = (code: number) => {
      if (stopping) return;
      stopping = true; result = code;
      for (const child of children) signal(child, "SIGTERM");
      timer = setTimeout(() => { for (const child of children) signal(child, "SIGKILL"); }, options.graceMs ?? 7000);
    };
    const interrupt = () => stop(130);
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    if (!commands.length) { finish(); return; }
    for (const command of commands) {
      const child = spawn(command.command, command.args, {
        cwd: options.cwd, env: options.env ?? process.env, stdio: options.stdio ?? "inherit",
        detached: process.platform !== "win32",
      });
      children.push(child);
      child.on("error", error => {
        console.error(`${command.name} failed to start: ${error.message}`); stop(1);
      });
      child.on("close", (code, sig) => {
        if (!stopping && (!options.oneShot || code !== 0)) {
          console.error(`${command.name} stopped (${sig ?? code}); stopping the dev group.`);
          stop(code && code > 0 ? code : 1);
        }
        if (--pending === 0) finish();
      });
    }
  });
}

export async function dev() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  loadLocalEnv(root, "development");
  const port = process.env.CREAMA_DEV_PORT || "3300";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("CREAMA_DEV_PORT must be 1–65535.");
  const require = createRequire(import.meta.url);
  const env = { ...process.env, NODE_ENV: "development" as const };
  const migration = await runGroup([{ name: "migration", command: process.execPath,
    args: ["--import", "tsx", "bin/migrate.ts"] }], { cwd: root, env, oneShot: true });
  if (migration !== 0) return migration;
  // A signal during migration should cancel startup, even if migration exits cleanly.
  console.log(`Creama dev: web http://localhost:${port} + discovery/drift worker. Ctrl+C stops both.`);
  return runGroup([
    { name: "web", command: process.execPath, args: [require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", port] },
    { name: "worker", command: process.execPath, args: ["--import", "tsx", "bin/worker.ts"] },
  ], { cwd: root, env });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await dev(); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
