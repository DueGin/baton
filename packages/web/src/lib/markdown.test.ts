import { describe, expect, it } from "vitest";
import { markdownPlainText } from "./markdown.js";

describe("markdownPlainText", () => {
  it("flattens Markdown to one readable line for titles and previews", () => {
    expect(markdownPlainText("选择 **范围**：`src/` 还是 [全部](https://x.dev)?")).toBe("选择 范围：src/ 还是 全部?");
    expect(markdownPlainText("# 标题\n\n- 第一项\n- [ ] 第二项\n1. 第三项\n> 引用")).toBe("标题 第一项 第二项 第三项 引用");
    expect(markdownPlainText("~~旧~~ *新* _方案_ ![图](a.png)<br>下一行")).toBe("旧 新 方案 图 下一行");
    expect(markdownPlainText("snake_case_name stays")).toBe("snake_case_name stays");
  });
});
