import { describe, expect, it } from "vitest";
import { queueEditError, queueEditKey } from "./queue-editor.js";

describe("queue editor keyboard and validation", () => {
  it("saves Enter, leaves Shift+Enter for a newline, and cancels Escape", () => {
    expect(queueEditKey("Enter", false, false)).toBe("save");
    expect(queueEditKey("Enter", true, false)).toBeUndefined();
    expect(queueEditKey("Escape", false, false)).toBe("cancel");
    expect(queueEditKey("a", false, false)).toBeUndefined();
  });
  it("never saves or cancels during IME composition", () => {
    expect(queueEditKey("Enter", false, true)).toBeUndefined();
    expect(queueEditKey("Escape", false, true)).toBeUndefined();
  });
  it("rejects empty/whitespace drafts but permits multiline content", () => {
    expect(queueEditError("")).toBe("消息不能为空");
    expect(queueEditError(" \n\t ")).toBe("消息不能为空");
    expect(queueEditError(" \n新内容\n ")).toBeUndefined();
  });
});
