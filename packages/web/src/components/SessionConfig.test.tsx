import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoClient } from "../demo/client.js";
import { demoAgents } from "../demo/agents.js";
import { RunStore } from "../store.js";
import { SessionConfig } from "./SessionConfig.js";
import { SessionTabs } from "./SessionTabs.js";
import { TurnIndicator } from "./TurnIndicator.js";

const now = Date.parse("2026-11-10T07:00:00Z");
describe("session controls", () => {
  it("renders the agent defaults, hides unsupported fields and disables only closed nodes", async () => {
    const client = new DemoClient(() => now); const snapshot = await client.run("run-questions");
    const node = { ...snapshot.nodes[0]!, model: undefined, modeId: undefined, thinking: undefined };
    const agent = demoAgents.find(entry => entry.id === "claude")!;
    const updateNodeConfig = new RunStore(client).updateNodeConfig;
    const defaults = renderToStaticMarkup(<SessionConfig agent={agent} node={node} updateNodeConfig={updateNodeConfig} />);
    for (const label of ["默认 · Sonnet 4.6", "默认 · Medium", "默认 · Default"]) expect(defaults).toContain(label);
    for (const status of ["failed", "replaced", "canceled", "completed"] as const) {
      const html = renderToStaticMarkup(<SessionConfig agent={agent} node={{ ...node, status, model: "claude-haiku-4-5" }} updateNodeConfig={updateNodeConfig} />);
      expect(html).not.toContain('aria-label="思考级别"'); expect(html.includes('disabled=""')).toBe(status !== "completed");
    }
    expect(renderToStaticMarkup(<SessionConfig agent={{ ...agent, modes: [], models: [] }} node={node} updateNodeConfig={updateNodeConfig} />)).toBe("");
  });
  it("keeps the root first, then all sessions by creation time, including replacements", async () => {
    const snapshot = await new DemoClient(() => now).run("run-demo");
    const root = snapshot.nodes[0]!, earlier = { ...root, id: "earlier", createdAt: new Date(now - 9000).toISOString(), role: "旧成员", status: "replaced" as const };
    const later = { ...earlier, id: "later", createdAt: new Date(now).toISOString(), role: "接手者", status: "running" as const };
    const html = renderToStaticMarkup(<SessionTabs snapshot={{ ...snapshot, nodes: [later, earlier, root] }} selected={later.id} select={() => undefined} inspect={() => undefined} showTopology={() => undefined} />);
    expect([...html.matchAll(/id="session-tab-([^"]+)"/g)].map(match => match[1])).toEqual([root.id, earlier.id, later.id]);
    expect(html).toContain('class="session-tab is-replaced"'); expect(html).toContain('aria-selected="true" tabindex="0"');
  });
  it("marks running, completed, and idle session dots separately and labels their tabs", async () => {
    const snapshot = await new DemoClient(() => now).run("run-demo");
    const root = snapshot.nodes.find(node => node.id === snapshot.run.rootNodeId)!;
    const states = { running: "运行中", completed: "已完成", idle: "空闲" } as const;
    const nodes = (["running", "completed", "idle"] as const).map(status => ({ ...root, id: status, title: status, role: status, status }));
    const html = renderToStaticMarkup(<SessionTabs snapshot={{ ...snapshot, nodes, delegations: [], questions: [], escalations: [] }} selected="running" select={() => undefined} inspect={() => undefined} showTopology={() => undefined} />);
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
    expect(tabs).toHaveLength(nodes.length);
    for (const { status } of nodes) {
      const tab = tabs.find(button => button.includes(`id="session-tab-${status}"`));
      expect(tab).toContain(`aria-label="${status} · ${states[status]}"`);
      expect(tab).toContain(`title="${root.agentId} · ${status} · ${states[status]}"`);
      expect(tab).toContain(`class="status status-${status}" data-status="${status}"`);
    }
  });
  it("renders idle child waiting without a timer or thinking dots", async () => {
    const snapshot = await new DemoClient(() => now).run("run-questions");
    const html = renderToStaticMarkup(<TurnIndicator snapshot={snapshot} phase={{ kind: "idle_children", label: "空闲 · 等待 1 个子任务，结果送达后自动继续", related: [snapshot.nodes[1]!.id] }} inspect={() => undefined} />);
    expect(html).toContain("结果送达后自动继续"); expect(html).toContain(snapshot.nodes[1]!.title);
    for (const marker of ["turn-thinking-dots", "motion-safe", "turn-elapsed", "无新输出"]) expect(html).not.toContain(marker);
  });
  it("projects demo config events immediately, distinguishes running and idle turns, and patches run review independently", async () => {
    const client = new DemoClient(() => now); const store = new RunStore(client);
    try {
      await store.open("run-questions"); const snapshot = store.getSnapshot().snapshot!, node = snapshot.nodes[0]!;
      expect((await client.updateNodeConfig(node.id, { modeId: "plan", thinking: "high" })).applied).toBe("next_turn");
      expect(store.getSnapshot().snapshot?.nodes[0]).toMatchObject({ id: node.id, modeId: "plan", thinking: "high" });
      await expect(client.updateNodeConfig(node.id, { thinking: "invalid" })).rejects.toThrow("400");
      await client.pauseRun(snapshot.run.id);
      expect((await client.updateNodeConfig(node.id, { model: "claude-haiku-4-5" })).applied).toBe("now");
      expect(store.getSnapshot().snapshot?.nodes[0]?.thinking).toBeUndefined();
      await client.updateNodeConfig(node.id, { modeId: null });
      expect(store.getSnapshot().snapshot?.nodes[0]?.modeId).toBeUndefined();
      await client.patchRun(snapshot.run.id, { policy: { leadReview: true } });
      expect(store.getSnapshot().snapshot?.run.policy).toEqual({ ...snapshot.run.policy, leadReview: true });
    } finally { store.close(); }
  });
});
