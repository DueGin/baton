import { applyEvent, type ItemRecord, type PullRequestRecord, type RunSnapshot } from "@baton/protocol";
import { createScenario } from "./scenario.js";

export function pullRequestDemo(now: number): { snapshot: RunSnapshot; items: ItemRecord[]; prs: PullRequestRecord[] } {
  const scenario = createScenario(now - 600000, "run-pull-requests"); const seed = scenario.events.reduce(applyEvent, scenario.initial); const ts = new Date(now - 120000).toISOString();
  const snapshot: RunSnapshot = { ...seed, run: { ...seed.run, projectId: "project-atlas", title: "Pull Requests · CI、评审与合并", titleSource: "human", status: "idle", updatedAt: new Date(now).toISOString(), policy: { ...seed.run.policy, prFeedback: "notify" } }, nodes: seed.nodes.map(node => ({ ...node, status: node.parentNodeId ? "completed" : "idle", endedAt: node.parentNodeId ? ts : undefined, activity: "PR 已登记" })), turns: seed.turns.map(turn => ({ ...turn, status: "completed", endedAt: ts })), permissions: [], questions: [], escalations: [], pullRequests: [] };
  const root = snapshot.run.rootNodeId; const runId = snapshot.run.id; const projectId = snapshot.run.projectId;
  const base: PullRequestRecord = { id: `${runId}:github:baton/demo#41`, runId, projectId, nodeId: root, toolSpanId: `${root}:pr-41`, source: "created", url: "https://github.com/baton/demo/pull/41", forge: "github", repo: "baton/demo", number: 41, title: "修复中文搜索边界", state: "open", headRef: "fix/search", baseRef: "main", author: "baton-bot", checks: { state: "failure", total: 6, passed: 5, failed: 1, pending: 0, failedChecks: [{ name: "integration / CJK search", url: "https://github.com/baton/demo/actions/runs/41" }] }, reviewDecision: "review_required", mergeable: "mergeable", additions: 128, deletions: 24, changedFiles: 5, commentCount: 3, createdAt: ts, remoteUpdatedAt: ts, lastCheckedAt: ts };
  const variant = (number: number, patch: Partial<PullRequestRecord>): PullRequestRecord => ({ ...base, number, id: `${runId}:github:baton/demo#${number}`, url: `https://github.com/baton/demo/pull/${number}`, toolSpanId: `${root}:pr-${number}`, ...patch });
  const success = { state: "success" as const, total: 5, passed: 5, failed: 0, pending: 0, failedChecks: [] };
  const prs = [base,
    variant(42, { title: "权限校验需要补充评审意见", checks: success, reviewDecision: "changes_requested", mergeable: "conflicting", headRef: "feat/auth" }),
    variant(43, { title: "文档与发布流程", state: "merged", mergedAt: ts, checks: success, reviewDecision: "approved", headRef: "docs/release" }),
    variant(44, { title: "Draft · 并发任务队列", state: "draft", checks: { state: "pending", total: 6, passed: 3, failed: 0, pending: 3, failedChecks: [] }, headRef: "feat/queue" }),
    variant(45, { title: "查询错误保留上次状态", state: "unknown", error: "gh: 网络连接超时，请检查 HTTPS_PROXY 后刷新", checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0, failedChecks: [] } }),
    variant(46, { title: "已关闭的早期尝试", state: "closed", closedAt: ts, checks: success }),
    variant(47, { title: "搜索索引全部检查通过", checks: success, reviewDecision: "approved" }),
    variant(48, { title: "参考实现（消息提及）", source: "mentioned", toolSpanId: undefined, checks: success }),
  ];
  const items: ItemRecord[] = [{ nodeId: root, seq: 1, ts, item: { type: "assistant_message", text: "实现已拆分成数个 PR。下方卡片和输入框的 PR 入口可以查看 CI、评审与合并状态；也可以将失败反馈排队发给我。" } }];
  for (const pr of prs.filter(pr => pr.source === "created")) {
    const callId = `pr-${pr.number}`;
    items.push({ nodeId: root, seq: items.length + 1, ts, item: { type: "tool_call", callId, name: "Bash", status: "completed", detail: { type: "shell", command: `gh pr create --title '${pr.title}' --body 'Implementation and validation'`, output: pr.url, exitCode: 0 } } });
    snapshot.toolSpans.push({ id: pr.toolSpanId!, runId, nodeId: root, callId, name: "Bash", kind: "shell", summary: `gh pr create · #${pr.number}`, status: "completed", startedAt: ts, endedAt: ts });
  }
  return { snapshot, items, prs };
}
