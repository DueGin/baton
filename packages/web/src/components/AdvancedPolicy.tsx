import { prFeedbackLabels } from "../lib/pull-requests.js";
import type { RunPolicy } from "@baton/protocol";

export function AdvancedPolicy({ policy, change }: { policy: RunPolicy; change: (patch: Partial<RunPolicy>) => void }) {
  return <details className="advanced-policy"><summary>高级策略</summary><div className="advanced-policy-fields">{([
    { key: "maxTeamSize", label: "最大团队成员数", fallback: 5, min: 1, max: 50, hint: "优先复用已有成员，超出上限的组队请求会被拒绝。" },
    { key: "stallMinutes", label: "停滞升级（分钟）", fallback: 10, min: 1, max: 1440, hint: "运行中的节点超过此时间无活动时，请你介入。" },
    { key: "maxRoundsPerDelegation", label: "每个委派最大轮次", fallback: 3, min: 1, max: 100, hint: "超出的追问先暂存，待你延长或取消。" },
  ] as const).map(field => <label key={field.key}>{field.label}<input aria-label={field.label} type="number" min={field.min} max={field.max} value={policy[field.key] ?? field.fallback} onChange={event => change({ [field.key]: Math.max(field.min, Math.min(field.max, Math.round(Number(event.target.value) || field.fallback))) })} /><span className="field-hint">{field.hint}</span></label>)}<label>PR 状态反馈<select aria-label="PR 状态反馈" value={policy.prFeedback ?? "notify"} onChange={event => change({ prFeedback: event.target.value === "off" ? "off" : event.target.value === "auto" ? "auto" : "notify" })}>{(Object.keys(prFeedbackLabels) as Array<keyof typeof prFeedbackLabels>).map(value => <option key={value} value={value}>{prFeedbackLabels[value]}</option>)}</select><span className="field-hint">提醒 CI 失败与评审要求修改；自动反馈会向创建者排队消息（每个 PR 每 10 分钟最多一次）。关闭时仅跟踪状态。</span></label></div></details>;
}
