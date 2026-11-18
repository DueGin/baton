import type { AgentEntry, AgentModel, TeamPresetInput } from "@baton/protocol";
import type { SelectOption } from "./listbox.js";
import { defaultAgentSpec } from "./teams.js";

export type AgentSpec = TeamPresetInput["lead"];

/** The 自定义… row's value; never a real model id. */
export const CUSTOM_MODEL = "\u0000custom-model";
export const DEFAULT_MODEL_LABEL = "默认模型";
export const UNLISTED_MODEL = "不在列表中";

export const findModel = (agent: AgentEntry | undefined, model: string | undefined): AgentModel | undefined => model ? agent?.models.find(entry => entry.id === model) : undefined;
/** True when `model` is empty (the agent's default) or one of the agent's reported models. */
export const modelListed = (agent: AgentEntry | undefined, model: string | undefined): boolean => !model || Boolean(findModel(agent, model));

/**
 * The model choices for one agent, from its configuration (`AgentEntry.models`):
 * 默认模型 (empty value — the agent decides) first, then the agent's models, then a saved value the agent does not list
 * (old presets, a changed catalog — kept and marked, never dropped), then 自定义… to type an id the catalog lacks.
 */
export function modelOptions(agent: AgentEntry | undefined, value?: string): SelectOption[] {
  const models = agent?.models ?? []; const fallback = models.find(model => model.isDefault);
  const options: SelectOption[] = [{ value: "", label: DEFAULT_MODEL_LABEL, description: fallback ? `由 agent 决定 · 当前 ${fallback.label || fallback.id}` : "由 agent 决定", pinned: true }];
  for (const model of models) {
    const label = model.label?.trim() || model.id;
    const description = [label !== model.id ? model.id : undefined, model.description].filter(Boolean).join(" · ");
    options.push({ value: model.id, label, ...(description ? { description } : {}), ...(model.isDefault ? { hint: "默认" } : {}) });
  }
  if (value && !modelListed(agent, value)) options.push({ value, label: value, description: agent ? `${agent.label} 未报告此模型，保存的值保持不变` : "未检测到所选 agent", hint: UNLISTED_MODEL, warning: UNLISTED_MODEL, pinned: true, separated: true });
  options.push({ value: CUSTOM_MODEL, label: "自定义…", description: "输入列表中没有的模型 ID", pinned: true, separated: true });
  return options;
}

/** The thinking levels a model accepts; an empty model (the agent's default) offers none. */
export const thinkingOptions = (agent: AgentEntry | undefined, model: string | undefined): NonNullable<AgentModel["thinkingOptions"]> => findModel(agent, model)?.thinkingOptions ?? [];
/** Keeps `thinking` only when the model accepts it. */
export function compatibleThinking(agent: AgentEntry | undefined, model: string | undefined, thinking: string | undefined): string | undefined {
  return thinking && thinkingOptions(agent, model).some(option => option.id === thinking) ? thinking : undefined;
}
/** A new model: the thinking level survives only when the new model accepts it. */
export function withModel<T extends AgentSpec>(agents: AgentEntry[], spec: T, model: string | undefined): T {
  const agent = agents.find(entry => entry.id === spec.agentId);
  return { ...spec, model: model || undefined, thinking: compatibleThinking(agent, model, spec.thinking) };
}
/**
 * A new agent: a model (and mode) the new agent also lists is kept; anything else falls back to the agent's defaults,
 * and the thinking level is dropped unless the resulting model accepts it.
 */
export function withAgent<T extends AgentSpec>(agents: AgentEntry[], spec: T, agentId: string): T {
  if (spec.agentId === agentId) return spec;
  const agent = agents.find(entry => entry.id === agentId);
  // defaultAgentSpec falls back to another ready agent for an unknown id; an unknown agent gets no defaults at all.
  const defaults: Partial<AgentSpec> = agent ? defaultAgentSpec(agents, agentId) : {};
  const model = spec.model && findModel(agent, spec.model) ? spec.model : defaults.model;
  const modeId = spec.modeId && agent?.modes.some(mode => mode.id === spec.modeId) ? spec.modeId : defaults.modeId;
  return { ...spec, agentId, model, modeId, thinking: compatibleThinking(agent, model, spec.thinking) };
}
