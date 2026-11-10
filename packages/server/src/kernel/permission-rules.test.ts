import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRule } from "@baton/protocol";
import { permissionInput, ruleMatches } from "./permission-rules.js";

const rule = (pattern: string): PermissionRule => ({ id: "r", toolName: "Write", pattern, decision: "allow", scope: "global", createdAt: "2026-11-10T00:00:00.000Z", hits: 0 });

describe("permission rule file matching", () => {
  it("reads Claude-style input.file_path and matches a glob relative to the run cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "baton-rule-"));
    const request = { id: "1", name: "Write", kind: "tool" as const, input: { file_path: join(cwd, "bye.txt"), content: "x" } };
    expect(permissionInput(request, cwd).file).toBe("bye.txt");
    expect(ruleMatches(rule("*.txt"), request, { agentId: "claude", runId: "run", cwd })).toBe(true);
    expect(ruleMatches(rule("src/**"), request, { agentId: "claude", runId: "run", cwd })).toBe(false);
  });
  it("matches across symlinked prefixes such as macOS /tmp → /private/tmp, for files that do not exist yet", () => {
    const cwd = mkdtempSync(join(tmpdir(), "baton-rule-"));
    const real = realpathSync(cwd);
    const request = { id: "2", name: "Write", kind: "tool" as const, input: { file_path: join(real, "new", "file.txt") } };
    expect(permissionInput(request, cwd).file).toBe("new/file.txt");
  });
});
