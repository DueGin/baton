import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuestionRecord } from "@baton/protocol";
import { QuestionCard } from "./QuestionCard.js";

const question: QuestionRecord = { id: "q/native", runId: "r", nodeId: "n", question: "确认", blocking: true, status: "pending", askedAt: "2026-11-10T07:00:00Z", source: "native", delivery: "inline", prompts: [
  { id: "scope", header: "范围", question: "搜索 **范围**？", options: [{ label: "当前项目", description: "响应更快，保留 `projectId`" }], allowFreeText: true },
  { id: "checks", header: "验证", question: "哪些验证？", options: [{ label: "中文" }, { label: "权限" }], multiSelect: true, allowFreeText: true },
] };
const render = (value = question, inline = false) => renderToStaticMarkup(<QuestionCard inline={inline} question={value} answer={() => undefined} busy={false} />);
describe("shared question cards", () => {
  it("renders native sections, descriptions, single/multi selection and an initially disabled submit", () => {
    const html = render();
    for (const text of ["等你回答", "等待本轮继续", "范围", "验证", "多选", 'role="radiogroup"', 'role="radio"', 'role="checkbox"', 'aria-checked="false"', "响应更快", "<code>projectId</code>", "其他", "请回答全部问题", '<strong>范围</strong>']) expect(html).toContain(text);
    expect(html).toContain('disabled="">提交回答'); expect(html).not.toContain("<textarea");
  });
  it("always offers ask_human free text and explains async delivery", () => {
    const html = render({ ...question, source: "ask_human", delivery: "async" });
    expect(html).toContain("<textarea"); expect(html).toContain("也可以自由回答"); expect(html).toContain("答案会作为新消息送达"); expect(html).not.toContain(">其他<");
  });
  it("collapses answered cards to the saved answer and explains cancellation safely", () => {
    const answered = render({ ...question, status: "answered", answer: "当前项目；中文与权限", answers: { scope: ["当前项目"], checks: ["中文", "权限"] } });
    expect(answered).toContain('<details class="question-answered"><summary>你的回答：当前项目；中文与权限</summary>'); expect(answered).not.toContain('open=""'); expect(answered).not.toContain("提交回答"); expect(answered).toContain("已继续"); expect(answered).not.toContain("等待本轮继续");
    const canceled = render({ ...question, status: "canceled", cancelReason: "会话已暂停 <script>" });
    expect(canceled).toContain("提问已取消"); expect(canceled).toContain("会话已暂停 &lt;script&gt;"); expect(canceled).not.toContain("<script>"); expect(canceled).not.toContain("提交回答");
  });
  it("renders the compact docked variant with a minimise toggle only while pending", () => {
    const compact = renderToStaticMarkup(<QuestionCard compact question={question} answer={() => undefined} busy={false} />);
    expect(compact).toContain("question-card question-pending is-compact"); expect(compact).toContain('aria-label="收起问题"'); expect(compact).toContain("响应更快，保留 <code>projectId</code>");
    const answered = renderToStaticMarkup(<QuestionCard compact question={{ ...question, status: "answered", answer: "当前项目" }} answer={() => undefined} busy={false} />);
    expect(answered).toContain("is-compact"); expect(answered).not.toContain("收起问题"); expect(answered).toContain("你的回答：当前项目");
  });
  it("lists one option per line with Markdown labels, renders the question as Markdown, and offers 不作答", () => {
    const rich: QuestionRecord = { ...question, prompts: [{ id: "scope", header: "范围", question: "选择 **范围**：\n\n- 当前项目\n- 所有项目", options: [{ label: "**当前项目**（推荐）", description: "只搜 `src/`" }, { label: "[所有项目](https://example.com)" }], allowFreeText: false }] };
    const html = renderToStaticMarkup(<QuestionCard compact question={rich} answer={() => undefined} decline={() => undefined} busy={false} />);
    expect(html).toContain("<strong>范围</strong>"); expect(html).toContain("<li>当前项目</li>");
    expect(html).toContain("<strong>当前项目</strong>（推荐）"); expect(html).toContain("<code>src/</code>");
    expect(html).toContain("所有项目"); expect(html).not.toContain("<a "); // links inside option buttons are unwrapped to text
    expect(html.match(/class="question-option"/g)).toHaveLength(2); expect(html).toContain('aria-label="范围"');
    expect(html).toContain('aria-label="不作答，关闭问题"');
    expect(renderToStaticMarkup(<QuestionCard question={rich} answer={() => undefined} busy={false} />)).not.toContain("不作答，关闭问题");
    const declined = renderToStaticMarkup(<QuestionCard compact question={{ ...rich, status: "canceled", cancelReason: "用户选择不作答", declinedAt: "2026-11-10T07:01:00Z" }} answer={() => undefined} decline={() => undefined} busy={false} />);
    expect(declined).toContain("未作答"); expect(declined).toContain("你选择了不作答"); expect(declined).not.toContain("提交回答"); expect(declined).not.toContain("不作答，关闭问题");
  });
  it("assigns the jump anchor only to transcript cards so inspector copies cannot duplicate IDs", () => {
    expect(render(question, true)).toContain('id="question-q%2Fnative"'); expect(render(question)).not.toContain('id="question-q%2Fnative"');
  });
});
