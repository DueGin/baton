import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ItemRecord } from "@baton/protocol";
import type { QuestionTranscriptEntry } from "./questions.js";
import { activeOutlineIndex, outlineItems } from "./outline.js";
import { ConversationOutline } from "../components/ConversationOutline.js";

const row = (seq: number, text: string, extra: Partial<ItemRecord> & { delivery?: "turn" | "queued" | "retracted" } = {}): QuestionTranscriptEntry => {
  const { delivery, ...rest } = extra;
  return { type: "row", entry: { row: { seq, nodeId: "n", ts: `2026-11-18T08:0${seq}:00Z`, item: { type: "user_message", text, ...(delivery ? { delivery } : {}) }, ...rest } } };
};

describe("conversation outline", () => {
  it("lists only the messages the human sent, as one-line plain previews", () => {
    const entries: QuestionTranscriptEntry[] = [
      row(1, "# 目标\n\n实现 **登录**"),
      row(2, '<baton-results>\n<result delegation="d1" status="success">done</result>\n</baton-results>'),
      { type: "row", entry: { row: { seq: 3, nodeId: "n", ts: "2026-11-18T08:03:00Z", item: { type: "assistant_message", text: "好的" } } } },
      row(4, "再加上 `邮箱` 校验", { delivery: "turn" }),
      row(5, "排队中", { delivery: "queued" }),
      row(6, "已回退", { delivery: "turn", rolledBack: true }),
      row(7, "![截图](attachment:att_1)", { delivery: "turn" }),
    ];
    expect(outlineItems(entries)).toEqual([
      { seq: 1, preview: "目标 实现 登录", ts: "2026-11-18T08:01:00Z" },
      { seq: 4, preview: "再加上 邮箱 校验", ts: "2026-11-18T08:04:00Z" },
      { seq: 7, preview: "截图", ts: "2026-11-18T08:07:00Z" },
    ]);
  });
  it("marks the last message whose top passed a third of the viewport as the current one", () => {
    expect(activeOutlineIndex([100, 500, 900], 0, 600)).toBe(0);
    expect(activeOutlineIndex([-400, 150, 700], 0, 600)).toBe(1);
    expect(activeOutlineIndex([-900, -300, 50], 0, 600)).toBe(2);
    expect(activeOutlineIndex([Infinity, Infinity], 0, 600)).toBe(0);
  });
  it("renders a rail with one labelled tick per message, and nothing for a single message", () => {
    const items = [{ seq: 1, preview: "实现登录", ts: "2026-11-18T08:01:00Z" }, { seq: 4, preview: "加上邮箱校验", ts: "2026-11-18T08:04:00Z" }];
    const scroll = { current: null };
    const html = renderToStaticMarkup(createElement(ConversationOutline, { items, scroll }));
    expect(html).toContain('aria-label="消息目录"'); expect(html.match(/class="outline-tick/g)).toHaveLength(2);
    expect(html).toContain('aria-label="跳到第 2 条消息：加上邮箱校验"'); expect(html).toContain('aria-current="location"');
    expect(renderToStaticMarkup(createElement(ConversationOutline, { items: items.slice(0, 1), scroll }))).toBe("");
  });
});
