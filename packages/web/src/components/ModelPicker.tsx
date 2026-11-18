import { useRef, useState } from "react";
import type { AgentEntry } from "@baton/protocol";
import { CUSTOM_MODEL, DEFAULT_MODEL_LABEL, modelListed, modelOptions } from "../lib/models.js";
import { Icon } from "./common.js";
import { Select } from "./Select.js";

/**
 * Picks a model from the selected agent's configuration (`AgentEntry.models`). 默认模型 (no model: the agent decides)
 * comes first; a saved id the agent does not list stays visible as 不在列表中; 自定义… switches to a text box for an id
 * the catalog lacks (Enter or leaving the box keeps it, Escape goes back to the list).
 */
export function ModelPicker({ agent, value, onChange, label = "Model", popoverMinWidth = 250 }: { agent?: AgentEntry; value?: string; onChange: (model: string | undefined) => void; label?: string; popoverMinWidth?: number }) {
  const [draft, setDraft] = useState<string | null>(null); const [refocus, setRefocus] = useState(false); const finished = useRef(false);
  if (draft !== null) {
    const finish = (keep: boolean, focus: boolean): void => {
      if (finished.current) return;
      finished.current = true;
      if (keep && (draft.trim() || undefined) !== (value || undefined)) onChange(draft.trim() || undefined);
      setRefocus(focus); setDraft(null);
    };
    return <div className="select model-picker-custom">
      <input autoFocus aria-label={label} value={draft} placeholder="输入模型 ID，回车确认" spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={() => finish(true, false)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); finish(true, true); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false, true); } }} />
      <button type="button" className="model-picker-confirm" title="使用此模型 ID" aria-label="使用此模型 ID" onMouseDown={event => event.preventDefault()} onClick={() => finish(true, true)}><Icon name="check" size={13} /></button>
    </div>;
  }
  return <Select label={label} value={value ?? ""} options={modelOptions(agent, value)} autoFocus={refocus} placeholder={DEFAULT_MODEL_LABEL} searchPlaceholder="搜索模型名称或 ID…" emptyText="没有匹配的模型" popoverMinWidth={popoverMinWidth}
    onChange={(next, { query }) => {
      if (next !== CUSTOM_MODEL) { onChange(next || undefined); return; }
      // Start from what was typed in the search box, else from an unlisted saved id.
      finished.current = false; setDraft(query.trim() || (value && !modelListed(agent, value) ? value : ""));
    }} />;
}
