import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectListbox } from "./Select.js";
import { ModelPicker } from "./ModelPicker.js";
import { AgentFields } from "./TeamForms.js";
import { demoAgents } from "../demo/agents.js";
import { modelOptions } from "../lib/models.js";

const noop = (): undefined => undefined;

describe("ModelPicker", () => {
  it("replaces the native Model/Mode/Thinking controls of AgentFields, keeping their accessible names", () => {
    const fields = renderToStaticMarkup(<AgentFields agents={demoAgents} value={{ agentId: "codex", model: "gpt-5.2", modeId: "plan", thinking: "xhigh" }} onChange={noop} />);
    expect(fields).not.toContain("<select"); expect(fields).not.toContain("<datalist");
    for (const label of ["Agent", "Model", "Mode", "Thinking"]) expect(fields).toContain(`aria-label="${label}"`);
    expect(fields).toContain(">GPT-5.2</span>"); expect(fields).toContain(">Read only</span>"); expect(fields).toContain(">Xhigh</span>");
  });
  const claude = demoAgents.find(agent => agent.id === "claude")!;
  it("shows the chosen model from the agent's list, or 默认模型 for none", () => {
    expect(renderToStaticMarkup(<ModelPicker agent={claude} value="claude-opus-4-6" onChange={noop} />)).toContain('<span class="select-value">Opus 4.6</span>');
    const none = renderToStaticMarkup(<ModelPicker agent={claude} onChange={noop} />);
    expect(none).toContain('aria-label="Model"'); expect(none).toContain('<span class="select-value">默认模型</span>');
    expect(renderToStaticMarkup(<ModelPicker label="提案模型 2" agent={claude} onChange={noop} />)).toContain('aria-label="提案模型 2"');
  });
  it("keeps an unlisted saved model visible and marked", () => {
    const html = renderToStaticMarkup(<ModelPicker agent={claude} value="claude-opus-4-1" onChange={noop} />);
    expect(html).toContain('<span class="select-value">claude-opus-4-1</span>'); expect(html).toContain('<small class="select-warning">不在列表中</small>'); expect(html).toContain("is-warning");
  });
  it("lists the agent's models, 自定义… last, and only 默认模型 and 自定义… for an empty catalog", () => {
    const list = renderToStaticMarkup(<SelectListbox id="m" label="Model" options={modelOptions(claude, "claude-sonnet-4-6")} value="claude-sonnet-4-6" />);
    for (const text of ["默认模型", "Sonnet 4.6", "Opus 4.6", "Haiku 4.5", "claude-haiku-4-5 · 快速、便宜，不支持思考级别", "自定义…"]) expect(list).toContain(text);
    expect(list.indexOf("默认模型")).toBeLessThan(list.indexOf("Sonnet 4.6")); expect(list.indexOf("Haiku 4.5")).toBeLessThan(list.indexOf("自定义…"));
    const empty = renderToStaticMarkup(<SelectListbox id="m" label="Model" options={modelOptions({ ...claude, models: [] })} value="" />);
    expect(empty.match(/role="option"/g)).toHaveLength(2); expect(empty).toContain("默认模型"); expect(empty).toContain("自定义…");
  });
  it("disables Thinking for a model without levels and offers the levels of the chosen one", () => {
    const haiku = renderToStaticMarkup(<AgentFields agents={demoAgents} value={{ agentId: "claude", model: "claude-haiku-4-5" }} onChange={noop} />);
    expect(haiku).toMatch(/aria-label="Thinking"[^>]*disabled=""/);
    const opus = renderToStaticMarkup(<AgentFields agents={demoAgents} value={{ agentId: "claude", model: "claude-opus-4-6", thinking: "high" }} onChange={noop} />);
    expect(opus).not.toMatch(/aria-label="Thinking"[^>]*disabled=""/); expect(opus).toContain(">High</span>");
    // A stale level stays visible (and editable) even when the model offers none.
    const stale = renderToStaticMarkup(<AgentFields agents={demoAgents} value={{ agentId: "claude", model: "claude-haiku-4-5", thinking: "high" }} onChange={noop} />);
    expect(stale).not.toMatch(/aria-label="Thinking"[^>]*disabled=""/); expect(stale).toContain('<small class="select-warning">不在列表中</small>');
  });
});
