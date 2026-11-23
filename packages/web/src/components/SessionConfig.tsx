import { useEffect, useState } from "react";
import type { AgentEntry, NodeRecord, UpdateNodeConfigRequest } from "@baton/protocol";
import type { BatonClient } from "../api.js";
import { compatibleThinking, thinkingOptions } from "../lib/models.js";
import { Select, type SelectOption } from "./Select.js";

export function SessionConfig({ agent, node, updateNodeConfig }: { agent: AgentEntry; node: NodeRecord; updateNodeConfig: BatonClient["updateNodeConfig"] }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const disabled = saving || ["canceled", "replaced", "failed"].includes(node.status);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(timer);
  }, [message]);
  const defaultModel = agent.models.find(model => model.isDefault);
  const levels = thinkingOptions(agent, node.model ?? defaultModel?.id);
  const update = async (request: UpdateNodeConfigRequest) => {
    if (disabled) return;
    setSaving(true); setMessage("");
    try {
      const { applied } = await updateNodeConfig(node.id, request);
      if (applied === "next_turn") setMessage("本轮结束后生效");
    } catch (error) { setMessage(error instanceof Error ? error.message : "未能更新会话配置"); }
    finally { setSaving(false); }
  };
  const select = (key: keyof UpdateNodeConfigRequest, label: string, options: SelectOption[], fallback?: string) => {
    if (!options.length) return null;
    const defaultValue = options.find(option => option.value === fallback);
    return <label className="session-field"><span>{label}</span><Select variant="ghost" label={label} disabled={disabled} value={node[key] ?? ""}
      options={[{ value: "", label: defaultValue ? `默认 · ${defaultValue.label}` : "默认", pinned: true }, ...options]}
      onChange={value => {
        const patch: UpdateNodeConfigRequest = { [key]: value || null };
        if (key === "model" && node.thinking && !compatibleThinking(agent, value || defaultModel?.id, node.thinking)) patch.thinking = null;
        void update(patch);
      }} /></label>;
  };
  if (!agent.models.length && !agent.modes.length) return null;
  return <div className="session-config" aria-label="会话配置">
    {select("model", "模型", agent.models.map(model => ({ value: model.id, label: model.label || model.id, description: model.description })), defaultModel?.id)}
    {select("modeId", "模式", agent.modes.map(mode => ({ value: mode.id, label: mode.label || mode.id, description: mode.description, hint: [mode.isUnattended && "免确认", mode.isReadOnly && "只读"].filter(Boolean).join(" · ") })), agent.defaultModeId ?? undefined)}
    {select("thinking", "思考级别", levels.map(level => ({ value: level.id, label: level.label || level.id })), levels.find(level => level.isDefault)?.id)}
    {message && <span className="session-config-message" role="status">{message}</span>}
  </div>;
}
