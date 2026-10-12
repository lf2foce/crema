import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const hosts: ReturnType<typeof spawn>[] = [];
const childPids: number[] = [];
afterEach(() => {
  for (const host of hosts) host.kill("SIGKILL");
  for (const pid of childPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  hosts.length = 0; childPids.length = 0;
});
function host(commands: { name: string; command: string; args: string[] }[], oneShot = false) {
  const script = `import { runGroup } from './bin/dev.ts';
    process.exitCode = await runGroup(${JSON.stringify(commands)}, { graceMs: 200, oneShot: ${oneShot} });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd() });
  hosts.push(child);
  let text = "";
  child.stdout.on("data", data => { text += data; });
  child.stderr.on("data", data => { text += data; });
  const done = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve(code)); });
  return { child, done, text: () => text };
}
const command = (name: string, script: string) => ({ name, command: process.execPath, args: ["-e", script] });
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Timed out waiting for dev fixture");
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("dev process lifecycle (no database or model calls)", () => {
  it("successful one-shot migration returns zero", async () => {
    expect(await host([command("migration", "process.exit(0)")], true).done).toBe(0);
  });
  it("failed migration preserves its exit status", async () => {
    expect(await host([command("migration", "process.exit(3)")], true).done).toBe(3);
  });
  it("one service failure stops the other", async () => {
    const h = host([
      command("web", "setTimeout(()=>process.exit(2),300)"),
      command("worker", "console.log('PID:'+process.pid); setInterval(()=>{},1000)"),
    ]);
    await wait(() => /PID:\d+/.test(h.text()));
    const pid = Number(h.text().match(/PID:(\d+)/)![1]); childPids.push(pid);
    expect(await h.done).toBe(2); expect(alive(pid)).toBe(false);
  });
  it("Ctrl+C kills an uncooperative child and exits promptly", async () => {
    const h = host([command("worker", "process.on('SIGTERM',()=>{}); console.log('PID:'+process.pid); setInterval(()=>{},1000)")]);
    await wait(() => /PID:\d+/.test(h.text()));
    const pid = Number(h.text().match(/PID:(\d+)/)![1]); childPids.push(pid);
    h.child.kill("SIGINT");
    expect(await h.done).toBe(130); expect(alive(pid)).toBe(false);
  });
  it("interrupting migration does not report success", async () => {
    const h = host([command("migration", "process.on('SIGTERM',()=>process.exit(0)); console.log('READY'); setInterval(()=>{},1000)")], true);
    await wait(() => h.text().includes("READY")); h.child.kill("SIGINT");
    expect(await h.done).toBe(130);
  });
  it("a spawn error stops already-started services", async () => {
    const h = host([command("web", "setInterval(()=>{},1000)"), { name: "worker", command: "/creama-nonexistent-command", args: [] }]);
    expect(await h.done).toBe(1);
    expect(h.text()).toContain("worker failed to start");
  });
});
