import { describe, expect, it } from "vitest";
import { queueEditError, queueEditKey } from "./queue-editor.js";

describe("queue editor keyboard and validation", () => {
  const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13 };
  it("uses the selected send chord to save and leaves newlines and Escape available", () => {
    expect(queueEditKey(enter, "enter")).toBe("save");
    expect(queueEditKey(enter, "mod-enter")).toBeUndefined();
    expect(queueEditKey({ ...enter, shiftKey: true }, "enter")).toBeUndefined();
    expect(queueEditKey({ ...enter, key: "Escape" }, "mod-enter")).toBe("cancel");
    expect(queueEditKey({ ...enter, key: "a" }, "enter")).toBeUndefined();
  });
  it("never saves or cancels during IME composition", () => {
    expect(queueEditKey({ ...enter, keyCode: 229 }, "enter")).toBeUndefined();
    expect(queueEditKey({ ...enter, key: "Escape", isComposing: true }, "enter")).toBeUndefined();
  });
  it("rejects empty/whitespace drafts but permits multiline content", () => {
    expect(queueEditError("")).toBe("消息不能为空");
    expect(queueEditError(" \n\t ")).toBe("消息不能为空");
    expect(queueEditError(" \n新内容\n ")).toBeUndefined();
  });
});
