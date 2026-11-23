import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemRecord } from "@baton/protocol";
import { QueueDock } from "./QueueDock.js";
import { DeliveryIcon, MessageActionIcons } from "./MessageActions.js";
import { queuedRows } from "../lib/conversation.js";
import { QueueMessageEditor, DeleteQueuedMessage } from "./QueueMessageEditor.js";
const row = (seq: number, position: number): ItemRecord => ({ seq, nodeId: "n", ts: "2026-11-10T07:00:00Z", item: { type: "user_message", text: `第${seq}条 <script>bad()</script>`, delivery: "queued", queuePosition: position } });
describe("queue dock and icon accessibility", () => {
  it("shows sorted cards, a collapsible count, per-card controls and escaped expandable text", () => {
    const entries = queuedRows([row(1, 2), row(2, 1)], [], "n");
    const html = renderToStaticMarkup(<QueueDock entries={entries} actions={{}} reorder={() => undefined} act={() => undefined} edit={async () => true} />);
    expect(html).toContain("当前回合结束后，这 2 条消息会按顺序合并发送");
    expect(html.indexOf('data-queue-seq="2"')).toBeLessThan(html.indexOf('data-queue-seq="1"'));
    expect(html).toContain('aria-expanded="true"'); expect(html).toContain('aria-label="拖动第 1 条排队消息"');
    expect(html).toContain('aria-label="上移第 1 条排队消息"'); expect(html).toContain('aria-label="下移第 1 条排队消息"');
    expect(html).toContain('aria-label="展开消息全文"'); expect(html).toContain('aria-label="引导发送"'); expect(html).toContain('aria-label="编辑"'); expect(html.match(/aria-label="删除排队消息"/g)).toHaveLength(2); expect(html).toContain('title="删除这条排队消息"'); expect(html).not.toContain('aria-label="确认删除？"');
    expect(html).not.toContain('aria-label="立即发送"'); expect(html).not.toContain(">引导发送<"); expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;"); expect(html).toContain('aria-label="排队中"');
  });
  it("reveals send-now only on an unsupported queued card, and disables actions during saving", () => {
    const entries = queuedRows([row(1, 1)], [], "n");
    const html = renderToStaticMarkup(<QueueDock entries={entries} actions={{ "n:1": { steerUnsupported: true } }} pending reorder={() => undefined} act={() => undefined} edit={async () => true} />);
    expect(html).toContain("该 agent 不支持引导"); expect(html).toContain('aria-label="立即发送"'); expect(html).not.toContain('aria-label="引导发送"'); expect(html).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<QueueDock entries={[]} actions={{}} reorder={() => undefined} act={() => undefined} edit={async () => true} />)).toBe("");
  });
  it("also keeps delete in the inline editor, with save/cancel and a confirmation", () => {
    const html = renderToStaticMarkup(<QueueMessageEditor text="修改文本" busy={false} save={async () => true} cancel={() => undefined} remove={async () => undefined} />);
    expect(html).toContain('aria-label="编辑排队消息"'); expect(html).toContain("修改文本"); expect(html).toContain('aria-label="保存"'); expect(html).toContain('aria-label="取消编辑"'); expect(html).toContain('aria-label="删除这条"'); expect(html).toMatch(/(?:⌘|Ctrl) Enter 保存 · Enter 换行/u); expect(html).not.toContain('aria-label="确认删除"');
    const confirmation = renderToStaticMarkup(<DeleteQueuedMessage busy={false} close={() => undefined} remove={async () => undefined} />);
    expect(confirmation).toContain('aria-label="确认删除"'); expect(confirmation).toContain("这条消息不会送达 agent");
    const empty = renderToStaticMarkup(<QueueMessageEditor text="  " busy={false} save={async () => true} cancel={() => undefined} remove={async () => undefined} />);
    expect(empty).toMatch(/aria-label="保存" disabled=""/);
    const pending = renderToStaticMarkup(<QueueMessageEditor text="有内容" busy error="已送达，无法修改" save={async () => false} cancel={() => undefined} remove={async () => undefined} />);
    expect(pending).toContain('aria-busy="true"'); expect(pending).toContain('role="alert"'); expect(pending).toContain("已送达，无法修改");
  });
  it("marks edited messages with a small pencil without changing the shown row timestamp", () => {
    const original = row(1, 1); const entries = queuedRows([{ ...original, item: { type: "user_message", text: "已改成验证优先", delivery: "queued", queuePosition: 1, editedAt: "2026-11-10T07:10:00Z" } }], [], "n");
    const html = renderToStaticMarkup(<QueueDock entries={entries} actions={{}} reorder={() => undefined} act={() => undefined} edit={async () => true} />);
    expect(html).toContain("message-edited"); expect(html).toContain("已编辑"); expect(html).toContain(`dateTime="${original.ts}"`); expect(html).toContain("已改成验证优先");
  });
  it("gives all delivery and action icons readable names and tooltips", () => {
    for (const [delivery, label] of [["queued", "排队中"], ["steered", "已插入当前回合"], ["turn", "已送达"], ["retracted", "已撤回"]] as const) {
      const html = renderToStaticMarkup(<DeliveryIcon delivery={delivery} />); expect(html).toContain(`aria-label="${label}"`); expect(html).toContain("title="); expect(html).not.toContain(`>${label}<`);
    }
    const busy = renderToStaticMarkup(<MessageActionIcons delivery="steered" state={{ pending: "interrupt" }} act={() => undefined} />);
    expect(busy).toContain('aria-label="立即发送"'); expect(busy).toContain('disabled=""'); expect(busy).toContain("message-action-spinner");
    expect(renderToStaticMarkup(<DeliveryIcon delivery="turn" interrupted />)).toContain('aria-label="已中断并立即发送"');
  });
});
