import { prFeedbackLabels } from "../lib/pull-requests.js";
import type { RunPolicy } from "@baton/protocol";
import { Select, type SelectOption } from "./Select.js";

export const prFeedbackOptions: SelectOption[] = (Object.keys(prFeedbackLabels) as Array<keyof typeof prFeedbackLabels>).map(value => ({ value, label: prFeedbackLabels[value] }));

export function AdvancedPolicy({ policy, change }: { policy: RunPolicy; change: (patch: Partial<RunPolicy>) => void }) {
  return <details className="advanced-policy"><summary>高级策略</summary><div className="advanced-policy-fields">{([
    { key: "maxTeamSize", label: "最大团队成员数", fallback: 5, min: 1, max: 50, hint: "优先复用已有成员，超出上限的组队请求会被拒绝。" },
    { key: "stallMinutes", label: "停滞升级（分钟）", fallback: 10, min: 1, max: 1440, hint: "运行中的节点超过此时间无活动时，请你介入。" },
  ] as const).map(field => <label key={field.key}>{field.label}<input aria-label={field.label} type="number" min={field.min} max={field.max} value={policy[field.key] ?? field.fallback} onChange={event => change({ [field.key]: Math.max(field.min, Math.min(field.max, Math.round(Number(event.target.value) || field.fallback))) })} /><span className="field-hint">{field.hint}</span></label>)}<label>每个委派最大轮次<input aria-label="每个委派最大轮次" type="number" min={0} max={100} placeholder="不限" value={policy.maxRoundsPerDelegation || ""} onChange={event => { const value = Math.round(Number(event.target.value)); change({ maxRoundsPerDelegation: value > 0 ? Math.min(100, value) : undefined }); }} /><span className="field-hint">留空或填 0 表示不限制；设置后，超出的追问先暂存，待你延长或取消。</span></label><label>PR 状态反馈<Select label="PR 状态反馈" value={policy.prFeedback ?? "notify"} onChange={value => change({ prFeedback: value === "off" ? "off" : value === "auto" ? "auto" : "notify" })} options={prFeedbackOptions} /><span className="field-hint">提醒 CI 失败与评审要求修改；自动反馈会向创建者排队消息（每个 PR 每 10 分钟最多一次）。关闭时仅跟踪状态。</span></label></div></details>;
}
