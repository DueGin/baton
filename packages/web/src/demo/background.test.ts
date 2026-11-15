import { describe, expect, it } from "vitest";
import { applyEvent, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "./client.js";
import { backgroundSummary } from "../lib/background.js";
import { summarize } from "../lib/derive.js";
const base = Date.parse("2026-11-15T01:00:00Z");
describe("background process demo", () => {
  it("exposes tree/inferred/exited entries and folds the Vite child", async () => {
    const client = new DemoClient(() => base); const snapshot = await client.run("run-background"); const entries = snapshot.backgroundProcesses!;
    expect(entries).toHaveLength(3); expect(backgroundSummary(snapshot)).toMatchObject({ count: 2, hasPorts: true });
    expect(entries.find(process => process.attribution === "tree")).toMatchObject({ command: "npm run dev", ports: [5173], children: [{ pid: 4202 }] });
    expect(entries.some(process => process.attribution === "inferred" && process.ports.includes(8000))).toBe(true);
    expect(entries.some(process => process.status === "exited")).toBe(true);
    expect((await client.background()).length).toBe(2); expect((await client.background("all")).length).toBe(3);
    expect(summarize(snapshot).backgroundCount).toBe(2);
    for (const process of entries) expect(snapshot.nodes.some(node => node.id === process.nodeId)).toBe(true);
  });
  it("upserts stopping and exited entries, replays SSE and dismisses without killing", async () => {
    let now = base; const client = new DemoClient(() => now); const before = await client.run("run-background");
    const events: RunEventEnvelope[] = []; const controller = new AbortController(); const streaming = client.events(before.run.id, before.lastSeq, event => events.push(event), controller.signal);
    const [dev, python] = before.backgroundProcesses!;
    await client.stopBackground(dev!.id); expect((await client.run(before.run.id)).backgroundProcesses![0]!.status).toBe("stopping");
    expect((await client.background()).length).toBe(2);
    await client.dismissBackground(python!.id, { dismissed: true }); expect((await client.background()).length).toBe(1);
    expect((await client.background("all")).find(process => process.id === python!.id)).toMatchObject({ dismissed: true, status: "running" });
    now += 1600; const after = await client.run(before.run.id);
    expect(after.backgroundProcesses).toHaveLength(3); expect(after.backgroundProcesses![0]).toMatchObject({ status: "exited", stoppedBy: "human" });
    controller.abort(); await streaming; expect(events.reduce(applyEvent, before)).toEqual(after); expect(summarize(after).backgroundCount).toBe(0);
    await client.dismissBackground(python!.id, { dismissed: false }); expect((await client.background()).length).toBe(1);
  });
  it("keeps services on default cancellation and stops them only when requested", async () => {
    let now = base; const client = new DemoClient(() => now); await client.cancelRun("run-background");
    expect(backgroundSummary(await client.run("run-background")).count).toBe(2);
    await client.cancelRun("run-background", { stopBackground: true });
    expect((await client.run("run-background")).backgroundProcesses!.filter(process => process.status === "stopping")).toHaveLength(2);
    now += 2000; const after = await client.run("run-background");
    expect(after.run.status).toBe("canceled"); expect(backgroundSummary(after).count).toBe(0);
  });
});
