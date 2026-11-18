import { useSyncExternalStore } from "react";
import type { ItemRecord } from "@baton/protocol";
import { reasoningBlockId, reasoningOptions, reasoningPreferences, type ReasoningPreference } from "../lib/reasoning.js";
import { Select } from "./Select.js";

export function ReasoningControls({ rows, settings = false }: { rows?: ItemRecord[]; settings?: boolean }) {
  const { preference } = useSyncExternalStore(reasoningPreferences.subscribe, reasoningPreferences.getSnapshot, reasoningPreferences.getSnapshot);
  const ids = rows?.filter(row => row.item.type === "reasoning").map(row => reasoningBlockId(row.nodeId, row.seq)) ?? [];
  return <div className={settings ? "reasoning-settings-control" : "reasoning-toolbar-controls"}>
    <label><span>{settings ? "思考过程显示" : "思考"}</span><Select label="思考过程显示" value={preference} onChange={value => reasoningPreferences.setPreference(value as ReasoningPreference)} options={reasoningOptions} popoverMinWidth={settings ? 0 : 190} /></label>
    {rows && <details className="reasoning-bulk-menu" data-menu><summary title="当前会话中的思考块">全部</summary><div><button type="button" disabled={!ids.length} onClick={event => { reasoningPreferences.setBlocks(ids, true); event.currentTarget.closest("details")?.removeAttribute("open"); }}>全部展开</button><button type="button" disabled={!ids.length} onClick={event => { reasoningPreferences.setBlocks(ids, false); event.currentTarget.closest("details")?.removeAttribute("open"); }}>全部折叠</button></div></details>}
    {settings && <p className="muted">默认折叠。手动展开或收起某一块后，本页会记住你的选择；会话和节点详情同步，状态条预览独立控制。</p>}
  </div>;
}
