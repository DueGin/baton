import { describe, expect, it } from "vitest";
import { briefPrompt, resultsPrompt, followupPrompt, noticePrompt, correctionPrompt } from "../../../server/src/kernel/prompts.js";
import { createScenario, replay } from "../demo/scenario.js";
import { demoBriefPrompt, demoResultsPrompt, demoFollowupPrompt, demoNoticePrompt } from "../demo/prompts.js";
import { parseBatonMessage } from "./baton-messages.js";

const snapshot = replay(createScenario(Date.parse("2026-11-10T07:00:00Z")), Date.parse("2026-11-10T07:01:26Z"));
const edge = snapshot.delegations.find(delegation => delegation.brief.readonly)!;

describe("baton protocol transcript messages", () => {
  it("parses the server assignment format with context, acceptance, readonly and schema", () => {
    const parts = parseBatonMessage(briefPrompt(edge));
    expect(parts).toEqual([{ type: "assignment", delegationId: edge.id, title: edge.brief.title, role: edge.role, task: edge.brief.task, context: edge.brief.context, acceptance: edge.brief.acceptance, readonly: true, outputSchema: JSON.stringify(edge.brief.outputSchema, null, 2) }]);
    const minimum = { ...edge, role: undefined, brief: { title: "Small task", task: "Inspect the project" } };
    expect(parseBatonMessage(briefPrompt(minimum))?.[0]).toMatchObject({ task: "Inspect the project", acceptance: [], readonly: false });
  });

  it("handles multiple delivered results, decodes attribute entities and keeps JSON/artifacts separate", () => {
    const success = snapshot.delegations.find(delegation => delegation.result?.status === "success")!;
    const partial = { ...success, id: "partial-result", brief: { ...success.brief, title: 'Inspect "A&B" <workspace>' }, result: { ...success.result!, status: "partial" as const, reported: false } };
    const parts = parseBatonMessage(resultsPrompt([success, partial]));
    const message = parts?.[0];
    expect(message?.type).toBe("results");
    if (message?.type !== "results") throw new Error("expected results");
    expect(message.results).toHaveLength(2);
    expect(message.results[0]).toMatchObject({ title: success.brief.title, outcome: "success", summary: success.result!.summary, resultText: JSON.stringify(success.result!.result, null, 2) });
    expect(message.results[0]!.artifactsText).toContain("- file: src/search.ts");
    expect(message.results[1]).toMatchObject({ title: partial.brief.title, outcome: "partial" });
    expect(message.results[1]!.note).toContain("report_result");
  });

  it("recognizes only complete baton wrappers and leaves malformed content as original text", () => {
    expect(parseBatonMessage("<script>hello</script>")).toBeNull();
    expect(parseBatonMessage('<baton-assignment delegation="x">missing sections</baton-assignment>')).toBeNull();
    expect(parseBatonMessage('<baton-results><result delegation="d" status="completed" outcome="success" title="x">done</result>')).toBeNull();
    expect(parseBatonMessage('<baton-results><result delegation="d" status="completed" outcome="bogus" title="x">done</result></baton-results>')).toBeNull();
    expect(parseBatonMessage('<baton-results><result delegation="d" status="completed" outcome="success" title="x" onclick="bad">done</result></baton-results>')).toBeNull();
    expect(parseBatonMessage(`preface\n${briefPrompt(edge)}\nafter`)).toMatchObject([{ type: "text", text: "preface\n" }, { type: "assignment", delegationId: edge.id }, { type: "text", text: "\nafter" }]);
  });

  it("retains truncated result text without throwing", () => {
    const large = { ...edge, result: { status: "failed" as const, summary: "Failed", reported: true, finalText: "", result: { details: "x".repeat(9000) } } };
    const parts = parseBatonMessage(resultsPrompt([large]));
    expect(parts?.[0]?.type).toBe("results");
    if (parts?.[0]?.type !== "results") throw new Error("expected results");
    expect(parts[0].results[0]!.resultText).toContain("[Truncated.");
  });
  it("parses notice bodies leniently and rejects incomplete notices", () => {
    expect(parseBatonMessage('<baton-notice kind="reassigned" old="d1">\n任务 d1 → d2\n<script>bad()</script>\n</baton-notice>')).toEqual([{ type: "notice", text: '任务 d1 → d2\n<script>bad()</script>' }]);
    expect(parseBatonMessage('<baton-notice>missing end')).toBeNull();
    expect(parseBatonMessage('<baton-notice> </baton-notice>')).toBeNull();
    for (const kind of ["team", "system", "correction"] as const) expect(parseBatonMessage(`<baton-notice kind="${kind}">通知内容</baton-notice>`)).toEqual([{ type: "notice", kind, text: "通知内容" }]);
  });
  it("parses followups with decoded delegation IDs and rejects incomplete or invalid wrappers", () => {
    expect(parseBatonMessage('<baton-followup delegation="d&amp;1">请补充测试\n\n- 中文</baton-followup>')).toEqual([{ type: "followup", delegationId: "d&1", text: "请补充测试\n\n- 中文" }]);
    for (const text of ['<baton-followup delegation="d">unfinished', '<baton-followup>no delegation</baton-followup>', '<baton-followup delegation="d"> </baton-followup>', '<baton-followup delegation="d" onclick="bad">text</baton-followup>', '<baton-followup delegation="d"><baton-notice>nested</baton-notice></baton-followup>']) expect(parseBatonMessage(text)).toBeNull();
  });
  it("parses complete answers only and falls back for malformed question attributes", () => {
    expect(parseBatonMessage('<baton-answer question="q1">\n选择 A\n</baton-answer>')).toEqual([{ type: "answer", questionId: "q1", text: "选择 A" }]);
    expect(parseBatonMessage('<baton-answer>answer</baton-answer>')).toBeNull();
    expect(parseBatonMessage('<baton-answer question="q1" onclick="bad">answer</baton-answer>')).toBeNull();
    expect(parseBatonMessage('<baton-answer question="q1">unfinished')).toBeNull();
  });

  it("keeps browser demo format exactly equal to server output", () => {
    expect(demoFollowupPrompt('d"<&', "追问\n正文")).toBe(followupPrompt('d"<&', "追问\n正文"));
    for (const kind of ["team", "system", "correction"] as const) expect(demoNoticePrompt(kind, "内容")).toBe(noticePrompt(kind, "内容"));
    expect(parseBatonMessage(correctionPrompt(["tests must be a number"]))?.[0]).toMatchObject({ type: "notice", kind: "correction" });
    for (const delegation of snapshot.delegations) expect(demoBriefPrompt(delegation)).toBe(briefPrompt(delegation));
    expect(demoResultsPrompt(snapshot.delegations)).toBe(resultsPrompt(snapshot.delegations));
    expect(demoResultsPrompt([{ ...edge, result: undefined }])).toBe(resultsPrompt([{ ...edge, result: undefined }]));
  });
});
