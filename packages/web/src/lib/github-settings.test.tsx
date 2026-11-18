import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { githubForm, githubPayload } from "./github-settings.js";
import { GithubFields } from "../components/GithubSettings.js";
import { AdvancedPolicy, prFeedbackOptions } from "../components/AdvancedPolicy.js";
describe("GitHub and PR policy settings", () => {
  it("loads defaults, preserves exact env values, validates keys and duplicates", () => {
    expect(githubForm()).toEqual({ ghPath: "", trackMentioned: true, env: [] });
    const form = githubForm({ ghPath: "/usr/local/bin/gh", trackMentioned: false, env: { HTTPS_PROXY: "http://localhost:7890" } });
    expect(githubPayload(form)).toEqual({ ghPath: "/usr/local/bin/gh", trackMentioned: false, env: { HTTPS_PROXY: "http://localhost:7890" } });
    expect(() => githubPayload({ ...form, env: [{ key: "BAD NAME", value: "x" }] })).toThrow("环境变量名");
    expect(() => githubPayload({ ...form, env: [...form.env, ...form.env] })).toThrow("重复");
    expect(githubPayload({ ...form, ghPath: "", env: [] })).toEqual({ ghPath: "", env: {}, trackMentioned: false });
  });
  it("renders editable gh/env fields, tracking toggle and three feedback strategies", () => {
    const html = renderToStaticMarkup(<GithubFields value={githubForm({ env: { HTTPS_PROXY: "http://localhost:7890" } })} change={() => undefined} />);
    for (const text of ["gh 路径", "跟踪提及的 PR", "HTTPS_PROXY", "http://localhost:7890", "添加变量", 'aria-label="删除环境变量 1"']) expect(html).toContain(text);
    const policy = renderToStaticMarkup(<AdvancedPolicy policy={{ autoApprove: false, maxDepth: 3, maxActiveChildren: 6 }} change={() => undefined} />);
    expect(policy).toMatch(/aria-label="PR 状态反馈"[^>]*><span class="select-value">提醒我处理<\/span>/); expect(prFeedbackOptions.map(option => option.value)).toEqual(["off", "notify", "auto"]);
    expect(policy).toContain("每 10 分钟");
  });
});
