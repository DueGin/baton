import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CheckpointRecord, ItemRecord, RunEventEnvelope } from "@baton/protocol";
import { checkpointFor, confirmText, rollbackChoices, rollbackTarget, rolledBackGroups } from "../lib/rollback.js";
import { RollbackMenuView, RolledBackToggle } from "./RollbackMenu.js";
import { Transcript, TranscriptRow } from "./Transcript.js";
import { DemoClient } from "../demo/client.js";
import { RunStore } from "../store.js";

const ts = "2026-11-18T00:00:00.000Z";
const human = (seq: number, delivery: "turn" | "steered" | undefined, turnId?: string, extra: Partial<ItemRecord> = {}): ItemRecord => ({ seq, nodeId: "n", ts, turnId, item: { type: "user_message", text: `m${seq}`, ...(delivery ? { delivery } : {}) }, ...extra });
const reply = (seq: number, turnId: string, extra: Partial<ItemRecord> = {}): ItemRecord => ({ seq, nodeId: "n", ts, turnId, item: { type: "assistant_message", text: `r${seq}` }, ...extra });
const checkpoint = (itemSeq: number, extra: Partial<CheckpointRecord> = {}): CheckpointRecord => ({ id: `cp${itemSeq}`, runId: "r", nodeId: "n", itemSeq, createdAt: ts, files: { cwd: "/repo", ref: "abc" }, conversation: "native", ...extra });

describe("rollback choices", () => {
  const rows = [human(1, undefined, "t1"), reply(2, "t1"), human(3, "turn", "t2"), human(4, "turn", "t2"), human(5, "steered", "t2"), reply(6, "t2")];
  it("maps messages to their checkpoint (own, or the batch's) and steered ones to none", () => {
    const list = [checkpoint(3), checkpoint(1)];
    expect(checkpointFor(rows[0]!, rows, list)?.id).toBe("cp1");
    expect(checkpointFor(rows[3]!, rows, list)?.id).toBe("cp3");
    expect(checkpointFor(rows[4]!, rows, list)).toBeUndefined();
    expect(rollbackTarget(rows[0]!, true)).toBe(true);
    expect(rollbackTarget(rows[1]!, false)).toBe(false);
    expect(rollbackTarget(human(9, undefined), false)).toBe(false);
    expect(rollbackTarget({ ...human(9, undefined), item: { type: "user_message", text: "<baton-assignment>…" } }, true)).toBe(false);
  });
  it("disables unavailable choices with the reason and counts file changes", () => {
    const [conversation, files, both] = rollbackChoices(rows[2]!, checkpoint(3), { status: "ready", files: [{ path: "a.ts", status: "modified" }, { path: "b.ts", status: "added" }] });
    expect(conversation).toEqual({ mode: "conversation", label: "回退会话" });
    expect(files).toEqual({ mode: "files", label: "回退文件", detail: "2 个文件会改变" });
    expect(both?.detail).toBe("2 个文件会改变");
    const noFiles = rollbackChoices(rows[2]!, checkpoint(3, { files: undefined }));
    expect(noFiles.map(choice => Boolean(choice.disabled))).toEqual([false, true, true]);
    expect(noFiles[1]!.disabled).toContain("没有文件快照");
    const unsupported = rollbackChoices(rows[2]!, checkpoint(3, { conversation: "unsupported" }));
    expect(unsupported.map(choice => choice.disabled)).toEqual(["这个 agent 不支持回退会话", undefined, "这个 agent 不支持回退会话"]);
    expect(rollbackChoices(rows[2]!, checkpoint(3, { conversation: "replay" }))[0]!.detail).toContain("重放");
    const steered = rollbackChoices(rows[4]!, undefined);
    expect(steered.every(choice => choice.disabled?.includes("插入当前回合"))).toBe(true);
    const done = rollbackChoices({ ...rows[2]!, rolledBack: true }, checkpoint(3));
    expect(done.map(choice => choice.disabled)).toEqual(["这条消息已经回退", undefined, "这条消息已经回退"]);
    expect(rollbackChoices(rows[2]!, checkpoint(3), { status: "loading" })[1]!.detail).toBe("正在计算改动…");
    expect(confirmText("both", { status: "ready", files: [{ path: "a", status: "added" }] })).toContain("还原 1 个文件");
  });
  it("groups consecutive rolled-back rows", () => {
    const entries = [human(1, "turn", "t1"), reply(2, "t1"), human(3, "turn", "t2", { rolledBack: true }), reply(4, "t2", { rolledBack: true }), human(5, "turn", "t3")].map(row => ({ type: "row" as const, entry: { row } }));
    expect(rolledBackGroups(entries)).toEqual({ start: [-1, -1, 2, 2, -1], size: new Map([[2, 2]]) });
  });
});

describe("rollback menu", () => {
  const noop = () => undefined;
  it("lists the three choices, disabled ones with their reason, and previews the files", () => {
    const html = renderToStaticMarkup(<RollbackMenuView loading={false} choices={rollbackChoices(human(3, "turn", "t2"), checkpoint(3, { files: undefined }))} choose={noop} back={noop} run={noop} close={noop} />);
    expect(html).toContain("回退会话"); expect(html).toContain("回退文件"); expect(html).toContain("回退会话和文件");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('title="这个检查点没有文件快照');
    const files = renderToStaticMarkup(<RollbackMenuView loading={false} choices={rollbackChoices(human(3, "turn", "t2"), checkpoint(3))} changes={{ status: "ready", files: [{ path: "src/a.ts", status: "added" }, { path: "b.md", status: "deleted" }] }} choose={noop} back={noop} run={noop} close={noop} />);
    expect(files).toContain("查看会改变的文件（2）"); expect(files).toContain("src/a.ts"); expect(files).toContain("is-added"); expect(files).not.toContain('disabled=""');
    expect(renderToStaticMarkup(<RollbackMenuView loading choices={[]} choose={noop} back={noop} run={noop} close={noop} />)).toContain("正在读取检查点");
  });
  it("confirms before running and shows errors", () => {
    const html = renderToStaticMarkup(<RollbackMenuView loading={false} choices={[]} confirm="both" changes={{ status: "ready", files: [] }} error="Rollback failed" choose={noop} back={noop} run={noop} close={noop} />);
    expect(html).toContain("确认回退会话和文件"); expect(html).toContain("返回"); expect(html).toContain('role="alert"'); expect(html).toContain("不会改动文件");
    expect(renderToStaticMarkup(<RollbackMenuView loading={false} choices={[]} confirm="files" busy choose={noop} back={noop} run={noop} close={noop} />)).toContain("回退中…");
  });
  it("puts 回退 on delivered human messages only", () => {
    const node = { id: "n", runId: "r", parentNodeId: null, delegationId: null, depth: 0, agentId: "claude", title: "t", cwd: "/repo", status: "idle", createdAt: ts, updatedAt: ts, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 }, turns: 1 } as const;
    const rollback = { client: new DemoClient(), nodeId: "n", rows: [], rollback: async () => ({ mode: "files" as const }), done: () => undefined };
    expect(renderToStaticMarkup(<TranscriptRow row={human(3, "turn", "t2")} node={node} rollback={rollback} />)).toContain('aria-label="回退"');
    expect(renderToStaticMarkup(<TranscriptRow row={reply(4, "t2")} node={node} rollback={rollback} />)).not.toContain('aria-label="回退"');
  });
  it("renders the hidden-rows bar", () => {
    expect(renderToStaticMarkup(<RolledBackToggle count={3} open={false} toggle={() => undefined} />)).toContain("已回退 3 条消息");
    expect(renderToStaticMarkup(<RolledBackToggle count={3} open toggle={() => undefined} />)).toContain("· 隐藏");
  });
});

describe("demo rollback", () => {
  const now = Date.parse("2026-11-10T07:00:00Z");
  it("hides rolled-back rows behind a bar and returns the draft", async () => {
    const client = new DemoClient(() => now), store = new RunStore(client);
    const snapshot = await client.run("run-conversation"), root = snapshot.run.rootNodeId;
    const events: RunEventEnvelope[] = [], controller = new AbortController();
    void client.events(snapshot.run.id, snapshot.lastSeq, event => events.push(event), controller.signal);
    const sent = await client.send(root, "改成表格形式", "c1", "interrupt");
    const list = (await client.checkpoints(root)).checkpoints;
    const target = list.find(entry => entry.itemSeq === sent.itemSeq)!;
    expect(target).toMatchObject({ conversation: "native", files: { cwd: "/workspace/notes" } });
    expect((await client.checkpointChanges(target.id)).files.length).toBeGreaterThan(0);
    const result = await client.rollback(root, { checkpointId: target.id, mode: "both" });
    expect(result).toMatchObject({ mode: "both", draft: "改成表格形式", conversation: "native" });
    expect(result.files?.length).toBeGreaterThan(0);
    await expect(client.rollback(root, { checkpointId: target.id, mode: "conversation" })).rejects.toThrow("已经回退");
    const items = (await client.items(root)).items;
    expect(items.filter(row => row.rolledBack).map(row => row.seq)[0]).toBe(sent.itemSeq);
    expect(events.some(event => event.type === "item" && event.rolledBack)).toBe(true);
    controller.abort();
    const latest = await client.run(snapshot.run.id);
    const html = renderToStaticMarkup(<Transcript showTopology={() => undefined} snapshot={latest} store={store} items={{ [root]: items }} itemStatus={{ [root]: "ready" }} nodeId={root} setNodeId={() => undefined} now={now} inspect={() => undefined} answer={() => undefined} busy={false} />);
    expect(html).toContain("rolled-back-toggle");
    expect(html).toMatch(/已回退 \d+ 条消息/);
    expect(html).not.toContain("rolled-back-row");
    expect(html).not.toContain(">改成表格形式<");
  });
});
