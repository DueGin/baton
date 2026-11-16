import { describe, expect, it } from "vitest";
import { applyEvent, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "./client.js";
import { sessionTimeline } from "../lib/timeline.js";

const base = Date.parse("2026-11-10T07:00:00Z");
describe("title and idle-session demo", () => {
  it("generates a title after 1.5s through run.updated and updates the list", async () => {
    let now = base; const client = new DemoClient(() => now);
    const initial = await client.createRun({ projectId: "project-atlas", agent: "claude", prompt: "全局搜索和独立审查", policy: { mode: "solo" } });
    expect(initial.run.titleSource).toBe("prompt");
    const events: RunEventEnvelope[] = []; const controller = new AbortController();
    const streaming = client.events(initial.run.id, initial.lastSeq, event => events.push(event), controller.signal);
    now += 1499; expect((await client.run(initial.run.id)).run.titleSource).toBe("prompt");
    now += 1; const generated = await client.run(initial.run.id);
    controller.abort(); await streaming;
    expect(generated.run.titleSource).toBe("generated"); expect(generated.run.title).not.toBe(initial.run.title);
    expect(events.reduce(applyEvent, initial)).toEqual(generated);
    expect((await client.runs()).find(run => run.id === initial.run.id)?.title).toBe(generated.run.title);
  });
  it("preserves human names from automatic jobs and allows explicit regeneration", async () => {
    let now = base; const client = new DemoClient(() => now);
    const initial = await client.createRun({ projectId: "project-atlas", agent: "codex", prompt: "改进全局搜索", policy: { mode: "solo" } });
    await client.patchRun(initial.run.id, { title: "自定义名字" }); now += 2000;
    expect((await client.run(initial.run.id)).run).toMatchObject({ title: "自定义名字", titleSource: "human" });
    await client.regenerateTitle(initial.run.id); now += 1500;
    expect((await client.run(initial.run.id)).run.titleSource).toBe("generated");
    await client.updateSettings({ titleModel: { enabled: false } });
    const disabled = await client.createRun({ projectId: "project-atlas", agent: "pi", prompt: "不生成标题", policy: { mode: "solo" } }); now += 2000;
    expect((await client.run(disabled.run.id)).run.titleSource).toBe("prompt");
    await client.regenerateTitle(disabled.run.id); now += 1500;
    expect((await client.run(disabled.run.id)).run.titleSource).toBe("generated");
    await client.updateSettings({ titleModel: null });
    await expect(client.regenerateTitle(disabled.run.id)).rejects.toThrow("配置标题模型");
  });
  it("stores settings in memory without exposing keys and supports clear, env and test", async () => {
    const client = new DemoClient(() => base);
    const saved = await client.updateSettings({ titleModel: { apiKey: "secret-write-only", apiKeyEnv: null } });
    expect(saved.titleModel?.hasApiKey).toBe(true); expect(JSON.stringify(saved)).not.toContain("secret-write-only");
    expect(JSON.stringify(await client.settings())).not.toContain('"apiKey":');
    expect((await client.updateSettings({ titleModel: { model: "another-model" } })).titleModel?.hasApiKey).toBe(true);
    expect((await client.updateSettings({ titleModel: { apiKey: "", apiKeyEnv: "TITLE_MODEL_KEY" } })).titleModel).toMatchObject({ hasApiKey: false, apiKeyEnv: "TITLE_MODEL_KEY" });
    expect(await client.testTitleModel({ sample: "测试" })).toMatchObject({ ok: true, title: "全局搜索与独立审查", latencyMs: 180 });
    expect(await client.testTitleModel({ titleModel: { model: "" } })).toMatchObject({ ok: false, latencyMs: 120 });
    await client.updateSettings({ titleModel: null }); expect((await client.settings()).titleModel).toBeUndefined();
  });
  it("includes valid completed turns separated by 2h and 15m without drifting with the clock", async () => {
    let now = base; const client = new DemoClient(() => now); const snapshot = await client.run("run-idle-gaps");
    for (const turn of snapshot.turns) {
      const node = snapshot.nodes.find(node => node.id === turn.nodeId)!;
      expect(node).toBeDefined(); expect(Date.parse(turn.startedAt)).toBeGreaterThanOrEqual(Date.parse(node.createdAt));
      expect(Date.parse(turn.endedAt!)).toBeGreaterThan(Date.parse(turn.startedAt));
    }
    const model = sessionTimeline(snapshot); expect(model.gaps.map(([a, b]) => b - a)).toEqual([7_200_000, 900_000]);
    now += 7_200_000; expect(sessionTimeline(await client.run(snapshot.run.id))).toEqual(model);
  });
});
