import { describe, expect, it } from "vitest";
import { ACP_AGENT_SPECS, AcpAgentSpecSchema, acpLaunch, modeFlags, scrubAcpEnv, versionDiagnostic } from "./acp-spec.js";
import { acpDialect } from "./providers/acp-dialect.js";
import { formElicitation, cursorQuestion } from "./providers/acp-elicitation.js";
describe("ACP specifications", () => {
  it("has a unique validated catalog of at least 30 agents", () => {
    expect(ACP_AGENT_SPECS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ACP_AGENT_SPECS.map(s => s.id)).size).toBe(ACP_AGENT_SPECS.length);
    for (const spec of ACP_AGENT_SPECS) {
      expect(AcpAgentSpecSchema.safeParse(spec).success).toBe(true);
      expect(spec.noScratchSession).toBe(true);
      for (const platform of ["darwin", "win32"] as const) {
        expect(acpLaunch(spec, "installed", platform).command).toBeTruthy();
        if (spec.npx) {
          const launch = acpLaunch(spec, "npx", platform);
          expect(launch.command).toBeTruthy();
          if (platform === "win32" && spec.npx[0] === "npx") expect(launch).toMatchObject({ command: "cmd.exe", windowsVerbatimArguments: true, args: ["/d", "/s", "/c", expect.stringContaining("npx.cmd")] });
        }
      }
    }
  });
  it("offers image prompts only for agents verified to advertise promptCapabilities.image", () => {
    expect(ACP_AGENT_SPECS.filter(s => s.images).map(s => s.id).sort()).toEqual(["gemini", "kimi", "opencode", "qwen"]);
    expect(AcpAgentSpecSchema.parse({ id: "x", label: "X", command: ["x"], homepage: "https://example.com", installHint: "x", mcp: { supported: true, http: true, sse: true, stdio: true } }).images).toBe(false);
  });
  it("uses explicit Kimi semantics before the generic mode heuristic", () => {
    const kimi = ACP_AGENT_SPECS.find(s => s.id === "kimi")!;
    expect(modeFlags("auto", kimi.modeMap).isUnattended).toBe(true);
    expect(modeFlags("yolo", kimi.modeMap).isUnattended).toBe(false);
    expect(modeFlags("yolo").isUnattended).toBe(true);
  });
  it("scrubs allow-all env case-insensitively without disturbing policy", () => {
    expect(scrubAcpEnv({ COPILOT_ALLOW_ALL: "1", copilot_allow_all: "true", GH_HOST: "enterprise", PATH: "/bin" }, ["COPILOT_ALLOW_ALL"])).toEqual({ GH_HOST: "enterprise", PATH: "/bin" });
  });
  it("checks numeric and branch-specific floors", () => {
    const opencode = ACP_AGENT_SPECS.find(s => s.id === "opencode")!;
    expect(versionDiagnostic("opencode 1.18.30", opencode)).toContain("1.18.31");
    expect(versionDiagnostic("opencode 2.0.13", opencode)).toContain("2.0.14");
    expect(versionDiagnostic("opencode 2.0.14", opencode)).toBeUndefined();
    expect(versionDiagnostic("2026.10.20-build", { minVersion: "2026.10.21" })).toBeTruthy();
    expect(versionDiagnostic("unknown", { minVersion: "2.0.0" })).toContain("Cannot verify");
  });
  it("normalizes Kimi streaming arguments and terminal output", () => {
    const dialect = acpDialect(ACP_AGENT_SPECS.find(s => s.id === "kimi"));
    expect(dialect.normalizeTool?.({ status: "in_progress", content: [{ type: "content", content: { type: "text", text: "partial args" } }, { type: "terminal", terminalId: "t1" }] })).toHaveProperty("content", [{ type: "terminal", terminalId: "t1" }]);
    expect(dialect.normalizeTool?.({ status: "failed", rawOutput: "bad\nCommand failed with exit code: 2." })).toMatchObject({ rawOutput: { stdout: "bad", exitCode: 2 } });
  });
});
describe("ACP form elicitation", () => {
  it("preserves field names and converts labels, booleans and multi-select values", () => {
    const form = formElicitation({ message: "Choose", requestedSchema: { properties: { flavor: { type: "string", oneOf: [{ const: "v", title: "Vanilla" }] }, approved: { type: "boolean" }, files: { type: "array", items: { enum: ["a", "b"] } }, note: { type: "string" } } } });
    expect(form.request).toMatchObject({ kind: "question", input: { questions: [{ id: "flavor", options: [{ label: "Vanilla" }] }, { id: "approved" }, { id: "files", multiSelect: true }, { id: "note" }] } });
    expect(form.reply({ behavior: "allow", updatedInput: { answers: { flavor: ["Vanilla"], approved: ["Yes"], files: ["a", "b"], note: ["fine"] } } })).toEqual({ action: "accept", content: { flavor: "v", approved: true, files: ["a", "b"], note: "fine" } });
    expect(form.reply({ behavior: "deny" })).toEqual({ action: "cancel" });
    expect(() => form.reply({ behavior: "allow", updatedInput: { answers: {} } })).toThrow("Missing ACP answer");
  });
  it("maps Cursor answers back to the original option IDs", () => {
    const question = cursorQuestion({ questions: [{ id: "q", prompt: "Pick", options: [{ id: "o1", label: "One" }], allowMultiple: true }] });
    expect(question.reply({ behavior: "allow", updatedInput: { answers: { q: ["One"] } } })).toEqual({ outcome: { outcome: "answered", answers: [{ questionId: "q", selectedOptionIds: ["o1"] }] } });
  });
});
