import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoClient } from "../demo/client.js";
import { Inbox } from "./Inbox.js";
import { RememberPermission } from "./HumanActions.js";
import { TranscriptRow } from "./Transcript.js";

describe("human inbox rendering", () => {
  it("renders all action types, source agent/role and pending messages safely", async () => {
    const client = new DemoClient(() => Date.parse("2026-11-10T07:00:00Z")); const items = await client.inbox();
    const snapshots = Object.fromEntries(await Promise.all([...new Set(items.map(item => item.runId))].map(async id => [id, await client.run(id)] as const)));
    const html = renderToStaticMarkup(<Inbox items={items} snapshots={snapshots} busy={false} loading={false} error={null} refresh={() => undefined} open={() => undefined} decide={() => undefined} approve={() => undefined} answer={() => undefined} resolve={() => undefined} />);
    for (const text of ["允许一次", "总是允许", "拒绝", "按原名单批准", "去处理", "等你回答", "自由回答", "codex", "builder", "延长 +2", "忽略", "取消该委派", "暂存的追问"]) expect(html).toContain(text);
    const question = items.find(item => item.kind === "question")!; if (question.kind !== "question") throw new Error("question");
    const node = snapshots[question.runId]!.nodes.find(row => row.id === question.question.nodeId)!;
    const answer = renderToStaticMarkup(<TranscriptRow row={{ seq: 1, nodeId: node.id, ts: question.question.askedAt, item: { type: "user_message", text: '<baton-answer question="q1">保持只读 <script>bad()</script></baton-answer>' } }} node={node} />);
    expect(answer).toContain("你的回答"); expect(answer).toContain("human-answer"); expect(answer).not.toContain("data-agent-card"); expect(answer).not.toContain("<script>");
  });
  it("renders permission detail without executing HTML", async () => {
    const client = new DemoClient(() => 0); const item = (await client.inbox()).find(row => row.kind === "permission")!;
    if (item.kind !== "permission") throw new Error("permission");
    const html = renderToStaticMarkup(<RememberPermission permission={{ ...item.permission, request: { ...item.permission.request, detail: { type: "shell", command: "<script>bad()</script>" } } }} busy={false} decide={() => undefined} />);
    expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
  });
});
