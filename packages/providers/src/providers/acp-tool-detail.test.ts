import { describe, expect, it } from "vitest";
import { acpToolDetail } from "./acp-tool-detail.js";
describe("ACP kind and content mapping", () => {
    it("uses ACP kinds when titles are descriptions", () => {
        expect(acpToolDetail({ kind: "execute", title: "Run tests", rawInput: { command: ["npm", "test"] }, rawOutput: { output: "passed", exitCode: 0 } })).toMatchObject({ type: "shell", command: "npm test", output: "passed", exitCode: 0 });
        expect(acpToolDetail({ kind: "read", title: "Read config", locations: [{ path: "config.json" }], content: [{ type: "content", content: { type: "text", text: "{}" } }] })).toMatchObject({ type: "read", filePath: "config.json", content: "{}" });
        expect(acpToolDetail({ kind: "edit", title: "Edit config", content: [{ type: "diff", path: "config.json", oldText: "old", newText: "new" }] })).toMatchObject({ type: "edit", filePath: "config.json", oldString: "old", newString: "new" });
    });
    it("maps terminal output using the referenced terminal", () => {
        expect(acpToolDetail({ kind: "execute", content: [{ type: "terminal", terminalId: "t1" }] }, new Map([["t1", { command: "echo hi", cwd: "/tmp", output: "hi", exit: { exitCode: 0 } }]]))).toEqual({ type: "shell", command: "echo hi", cwd: "/tmp", output: "hi", exitCode: 0 });
    });
});
