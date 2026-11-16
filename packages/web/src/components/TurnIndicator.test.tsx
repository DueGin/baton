import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemRecord, RunSnapshot, TurnRecord } from "@baton/protocol";
import { DemoClient } from "../demo/client.js";
import { RunStore } from "../store.js";
import { TurnFooter, TurnIndicator } from "./TurnIndicator.js";
import { Transcript } from "./Transcript.js";
import { Inspector } from "./Inspector.js";

const now = Date.parse("2026-11-16T08:17:10Z");
async function fixture() {
  const client = new DemoClient(() => now); const store = new RunStore(client); const seed = await client.run("run-conversation");
  const node = { ...seed.nodes[0]!, status: "idle" as const };
  const turn: TurnRecord = { id: "done", nodeId: node.id, runId: seed.run.id, startedAt: "2026-11-16T08:14:38Z", endedAt: "2026-11-16T08:17:10Z", status: "completed", trigger: "result", usage: { inputTokens: 1_000_000, outputTokens: 160_000 } };
  const snapshot: RunSnapshot = { ...seed, run: { ...seed.run, status: "idle" }, nodes: [node], turns: [turn], permissions: [], questions: [], delegations: [], toolSpans: [] };
  const rows: ItemRecord[] = [{ nodeId: node.id, seq: 1, turnId: turn.id, ts: turn.startedAt, item: { type: "user_message", text: "优化创作页底部与计费展示", delivery: "turn" } }, { nodeId: node.id, seq: 2, turnId: turn.id, ts: turn.endedAt!, item: { type: "assistant_message", text: "全部修改完成。" } }];
  return { client, store, node, turn, snapshot, rows };
}
describe("inline turn indicator", () => {
  it("places a completed-turn footer beneath that turn's final output and a live indicator after the latest item inside the scroll area", async () => {
    const { store, node, turn, snapshot, rows } = await fixture();
    const render = (value: RunSnapshot, messages: ItemRecord[]) => renderToStaticMarkup(<Transcript snapshot={value} store={store} items={{ [node.id]: messages }} itemStatus={{ [node.id]: "ready" }} nodeId={node.id} setNodeId={() => undefined} now={now} inspect={() => undefined} answer={() => undefined} busy={false} />);
    const ended = render(snapshot, rows);
    expect(ended).not.toContain("turn-indicator motion-safe"); expect(ended).not.toContain("正在回复"); expect(ended).toContain("用时 2m 32s"); expect(ended).toContain("1.16M tokens"); expect(ended).toContain("子任务结果");
    expect(ended.indexOf("全部修改完成。")).toBeLessThan(ended.indexOf('data-turn-footer="done"'));
    const running = { ...turn, id: "running", status: "running" as const, trigger: "followup" as const, startedAt: new Date(now - 2000).toISOString(), endedAt: undefined, usage: undefined };
    const live = render({ ...snapshot, turns: [...snapshot.turns, running] }, [...rows, { nodeId: node.id, seq: 3, turnId: running.id, ts: running.startedAt, item: { type: "reasoning", text: "计算新的方案" } }]);
    const indicatorAt = live.indexOf('aria-label="当前回合状态"');
    expect(live.indexOf("计算新的方案")).toBeLessThan(indicatorAt); expect(indicatorAt).toBeLessThan(live.indexOf('class="composer-tools"')); expect(live.indexOf('data-turn-footer="done"')).toBeLessThan(live.indexOf("计算新的方案"));
    expect(live).toContain("思考中"); expect(live).toContain("本轮 2s"); expect(live).not.toContain("conversation-live"); expect(live).toContain("turn-thinking-dots");
  });
  it("shows phase links, live tool time and quiet time while keeping reasoning preview collapsed", async () => {
    const { snapshot, node } = await fixture();
    const html = renderToStaticMarkup(<TurnIndicator phase={{ kind: "tool", label: "正在执行 shell: npm test", since: new Date(now - 40_000).toISOString(), toolSince: new Date(now - 6000).toISOString(), quiet: 40, related: [node.id] }} snapshot={snapshot} now={now} inspect={() => undefined} />);
    expect(html).toContain("工具 6s"); expect(html).toContain("本轮 40s"); expect(html).toContain("已 40s 无新输出"); expect(html).not.toContain("tokens");
    const question = renderToStaticMarkup(<TurnIndicator phase={{ kind: "question", label: "等你回答", since: new Date(now).toISOString(), quiet: 0, related: ["q"] }} snapshot={snapshot} now={now} inspect={() => undefined} jumpQuestion={() => undefined} />);
    expect(question).toContain("回答问题 ↗");
    const thinking = renderToStaticMarkup(<TurnIndicator phase={{ kind: "reasoning", label: "思考中", since: new Date(now).toISOString(), quiet: 0, related: [], reasoning: "private preview", tokens: 1_160_000 }} snapshot={snapshot} now={now} inspect={() => undefined} />);
    expect(thinking).toContain('aria-expanded="false"'); expect(thinking).not.toContain("private preview"); expect(thinking).toContain("1.16M tokens");
  });
  it("uses the same ended-turn footer and live placement in the inspector's recent transcript", async () => {
    const { snapshot, node, turn, rows, store } = await fixture();
    const render = (value: RunSnapshot) => renderToStaticMarkup(<Inspector snapshot={value} nodeId={node.id} now={now} close={() => undefined} converse={() => undefined} cancel={() => undefined} decide={() => undefined} busy={false} store={store} items={{ [node.id]: rows }} inspect={() => undefined} reassign={() => undefined} answer={() => undefined} resolve={() => undefined} />);
    const ended = render(snapshot); expect(ended.indexOf("全部修改完成。")).toBeLessThan(ended.indexOf('data-turn-footer="done"')); expect(ended).not.toContain('aria-label="当前回合状态"');
    const live = render({ ...snapshot, turns: [{ ...turn, status: "running", endedAt: undefined }] }); expect(live.indexOf("全部修改完成。")).toBeLessThan(live.indexOf('aria-label="当前回合状态"')); expect(live).not.toContain('data-turn-footer="done"');
  });
  it("renders status/error/trigger footers safely and disables pulse animation for reduced motion", async () => {
    const { turn } = await fixture();
    const failed = renderToStaticMarkup(<TurnFooter turn={{ ...turn, status: "failed", error: "<script>failure</script>" }} />);
    expect(failed).toContain("失败"); expect(failed).not.toContain("<script>"); expect(failed).toContain("&lt;script&gt;");
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)"); expect(css).toContain("@media (prefers-reduced-motion: reduce) { .turn-thinking-dots i { animation: none");
  });
});
