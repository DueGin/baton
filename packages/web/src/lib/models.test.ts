import { describe, expect, it } from "vitest";
import type { AgentEntry } from "@baton/protocol";
import { demoAgents } from "../demo/agents.js";
import { compatibleThinking, CUSTOM_MODEL, modelListed, modelOptions, thinkingOptions, withAgent, withModel } from "./models.js";

const agent = (id: string): AgentEntry => demoAgents.find(entry => entry.id === id)!;

describe("models from the agent's configuration", () => {
  it("lists 默认模型 first, then the agent's models, then 自定义…", () => {
    const options = modelOptions(agent("claude"), "claude-opus-4-6");
    expect(options.map(option => option.value)).toEqual(["", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", CUSTOM_MODEL]);
    expect(options[0]).toMatchObject({ label: "默认模型", description: "由 agent 决定 · 当前 Sonnet 4.6" });
    expect(options[1]).toMatchObject({ label: "Sonnet 4.6", description: "claude-sonnet-4-6", hint: "默认" });
    expect(options[2]).toMatchObject({ label: "Opus 4.6", description: "claude-opus-4-6 · 最强推理，适合架构与审查" }); expect(options[2]!.hint).toBeUndefined();
    expect(options.at(-1)).toMatchObject({ label: "自定义…", pinned: true, separated: true });
    expect(options.some(option => option.warning)).toBe(false);
  });
  it("keeps a saved model the agent does not list, marked 不在列表中", () => {
    const options = modelOptions(agent("codex"), "gpt-4.1-legacy");
    expect(options.map(option => option.value)).toEqual(["", "gpt-5.3-codex", "gpt-5.2", "gpt-5.1-codex-mini", "gpt-4.1-legacy", CUSTOM_MODEL]);
    expect(options.at(-2)).toMatchObject({ label: "gpt-4.1-legacy", hint: "不在列表中", warning: "不在列表中", pinned: true });
    expect(modelListed(agent("codex"), "gpt-4.1-legacy")).toBe(false); expect(modelListed(agent("codex"), "gpt-5.2")).toBe(true); expect(modelListed(agent("codex"), undefined)).toBe(true);
  });
  it("offers only 默认模型 and 自定义… when the agent reports no models, or is unknown", () => {
    const empty = { ...agent("claude"), models: [] };
    expect(modelOptions(empty).map(option => option.label)).toEqual(["默认模型", "自定义…"]); expect(modelOptions(empty)[0]!.description).toBe("由 agent 决定");
    expect(modelOptions(undefined, "some-model").map(option => option.value)).toEqual(["", "some-model", CUSTOM_MODEL]);
    expect(modelOptions(undefined, "some-model")[1]!.description).toBe("未检测到所选 agent");
  });
  it("drops a thinking level the new model does not accept", () => {
    const codex = agent("codex");
    expect(thinkingOptions(codex, "gpt-5.2").map(option => option.id)).toEqual(["low", "medium", "high", "xhigh"]); expect(thinkingOptions(codex, undefined)).toEqual([]);
    expect(compatibleThinking(codex, "gpt-5.3-codex", "high")).toBe("high"); expect(compatibleThinking(codex, "gpt-5.3-codex", "xhigh")).toBeUndefined();
    const spec = { agentId: "codex", model: "gpt-5.2", thinking: "xhigh", modeId: "plan" };
    expect(withModel(demoAgents, spec, "gpt-5.3-codex")).toEqual({ agentId: "codex", model: "gpt-5.3-codex", thinking: undefined, modeId: "plan" });
    expect(withModel(demoAgents, { ...spec, thinking: "high" }, "gpt-5.1-codex-mini")).toMatchObject({ model: "gpt-5.1-codex-mini", thinking: "high" });
    expect(withModel(demoAgents, spec, undefined)).toMatchObject({ model: undefined, thinking: undefined });
    expect(withModel(demoAgents, { agentId: "claude", model: "claude-opus-4-6", thinking: "high" }, "claude-haiku-4-5")).toMatchObject({ thinking: undefined });
  });
  it("resets an incompatible model, mode and thinking when the agent changes", () => {
    const spec = { role: "build", agentId: "codex", model: "gpt-5.2", thinking: "low", modeId: "plan" };
    expect(withAgent(demoAgents, spec, "codex")).toBe(spec);
    // Claude does not list gpt-5.2: its default model; "plan" exists for Claude and stays; "low" is not a Sonnet level.
    expect(withAgent(demoAgents, spec, "claude")).toEqual({ role: "build", agentId: "claude", model: "claude-sonnet-4-6", thinking: undefined, modeId: "plan" });
    // pi also lists gpt-5.2, so the model survives (its catalog entry has no thinking levels).
    expect(withAgent(demoAgents, spec, "pi")).toMatchObject({ agentId: "pi", model: "gpt-5.2", thinking: undefined });
    expect(withAgent(demoAgents, { agentId: "claude", model: "claude-sonnet-4-6", thinking: "high" }, "codex")).toMatchObject({ model: "gpt-5.3-codex", thinking: "high" });
    expect(withAgent(demoAgents, { agentId: "codex", modeId: "full-auto" }, "qwen")).toMatchObject({ agentId: "qwen", model: "qwen-default", modeId: "default" });
    expect(withAgent(demoAgents, spec, "not-detected")).toEqual({ role: "build", agentId: "not-detected", model: undefined, modeId: undefined, thinking: undefined });
  });
});
