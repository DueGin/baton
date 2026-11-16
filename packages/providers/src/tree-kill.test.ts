import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { descendantProcessIds, terminateProcessIds, terminateWithTreeKill } from "./tree-kill.js";

it.skipIf(process.platform === "win32")("captures and kills a tool process group even when its agent root exits first", async () => {
  const root = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "", pid = 0; root.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); pid = Number(output.trim()); });
  const alive = (id: number): boolean => { try { process.kill(id, 0); return true; } catch { return false; } };
  try {
    const until = Date.now() + 3000; while (!pid) { if (Date.now() > until) throw new Error("No tool pid"); await delay(5); }
    const family = await descendantProcessIds([root.pid!]); expect(family).toContain(pid);
    await terminateWithTreeKill(root, { gracefulTimeoutMs: 50, forceTimeoutMs: 50 });
    await terminateProcessIds(family);
    const end = Date.now() + 3000; while (alive(pid) && Date.now() < end) await delay(10);
    expect(alive(pid)).toBe(false);
  } finally { await terminateProcessIds([...(pid ? [pid] : []), ...(root.pid ? [root.pid] : [])]); }
});
