import { expect, it } from "vitest";
import { emptyUsage } from "@baton/protocol";
import { Store } from "./index.js";

it("lists distinct agent/model pairs with the root first, retaining unknown models", () => {
  const store = new Store(":memory:");
  try {
    const common = { cwd: "/project", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", usage: emptyUsage() };
    store.append("run", { type: "run.created", run: { ...common, id: "run", rootNodeId: "root", title: "Summary", status: "active", policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false } } });
    const node = (id: string, agentId: string, model?: string) => store.append("run", { type: "node.created", node: {
      ...common, id, agentId, model, title: id, runId: "run", parentNodeId: id === "root" ? null : "root", delegationId: id === "root" ? null : `delegation-${id}`,
      depth: id === "root" ? 0 : 1, status: "idle", turns: 0,
    } });
    node("first", "worker"); node("second", "worker", "shared"); node("root", "lead", "shared");
    node("duplicate", "worker", "shared"); node("unknown", "worker"); node("another", "lead", "other");
    expect(store.list()[0]?.models).toStrictEqual([
      { agentId: "lead", model: "shared" }, { agentId: "worker" }, { agentId: "worker", model: "shared" }, { agentId: "lead", model: "other" },
    ]);
  } finally { store.close(); }
});
