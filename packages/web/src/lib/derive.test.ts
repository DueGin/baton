import { expect, it } from "vitest";
import { applyEvent, type NodeRecord } from "@baton/protocol";
import { createScenario } from "../demo/scenario.js";
import { summarize } from "./derive.js";

it("summarizes distinct agent/model pairs root-first, preserving node creation order through updates", () => {
  const scenario = createScenario(Date.parse("2026-11-10T07:00:00Z"));
  const snapshot = scenario.events.reduce(applyEvent, scenario.initial);
  const [root] = snapshot.nodes;
  const node = (id: string, agentId: string, model?: string): NodeRecord => ({ ...root!, id, parentNodeId: root!.id, agentId, model });
  const input = { ...snapshot, nodes: [
    node("first", "pi", "shared-model"),
    node("second", "codex", "shared-model"),
    root!,
    node("third", "pi", "shared-model"),
    node("fourth", "pi", "other-model"),
    node("fifth", "pi"),
    node("sixth", "pi"),
  ] };
  const expected = [
    { agentId: root!.agentId, model: root!.model },
    { agentId: "pi", model: "shared-model" },
    { agentId: "codex", model: "shared-model" },
    { agentId: "pi", model: "other-model" },
    { agentId: "pi" },
  ];
  expect(summarize(input).models).toStrictEqual(expected);
  const updated = applyEvent(input, { type: "node.created", runId: snapshot.run.id, seq: snapshot.lastSeq + 1, ts: snapshot.run.updatedAt, node: node("seventh", "pi", "added-model") });
  expect(summarize(updated).models).toStrictEqual([...expected, { agentId: "pi", model: "added-model" }]);
});
