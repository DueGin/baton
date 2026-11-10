import { describe, expect, it } from "vitest";
import { applyEvent, type InboxItem, type PermissionRecord, type RunEventEnvelope } from "@baton/protocol";
import { DemoClient } from "../demo/client.js";
import { groupInbox, inboxId, inboxTime, permissionPattern, snapshotInbox, sortInbox } from "./inbox.js";
import { displayStatus, summarize } from "./derive.js";
import { matchPermissionRule } from "./permission-rules.js";

const base = Date.parse("2026-11-10T07:00:00Z");
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const permission: PermissionRecord = { id: "p", requestId: "p", runId: "r", nodeId: "n", status: "pending", requestedAt: at(0), request: { id: "p", name: "shell", kind: "tool", detail: { type: "shell", command: "  npm   test -- --watch  " } } };
describe("cross-run inbox projections", () => {
  it("groups runs by their oldest item and sorts each group oldest first without mutating input", () => {
    const item = (id: string, runId: string, time: number): InboxItem => ({ kind: "permission", runId, runTitle: runId, permission: { ...permission, id, runId, requestedAt: at(time) } });
    const rows = [item("c", "r1", 30), item("b", "r2", 20), item("a", "r1", 10)];
    expect(groupInbox(rows).map(group => [group.runId, group.items.map(inboxId)])).toEqual([["r1", ["permission:a", "permission:c"]], ["r2", ["permission:b"]]]);
    expect(rows.map(inboxId)).toEqual(["permission:c", "permission:b", "permission:a"]);
  });
  it("prefills normalized shell commands and file paths relative to cwd", () => {
    expect(permissionPattern(permission)).toBe("npm test -- --watch");
    expect(permissionPattern({ ...permission, request: { ...permission.request, detail: { type: "edit", filePath: "/project/src/app.ts" } } }, "/project/")).toBe("src/app.ts");
    expect(permissionPattern({ ...permission, request: { ...permission.request, detail: { type: "read", filePath: "/project-other/app.ts" } } }, "/project")).toBe("../project-other/app.ts");
    expect(permissionPattern({ ...permission, request: { ...permission.request, detail: { type: "read", filePath: "src/../lib/a.ts" } } }, "/project")).toBe("lib/a.ts");
    expect(permissionPattern({ ...permission, request: { ...permission.request, detail: undefined, input: { command: "  npm  test " } } })).toBe("npm test");
    expect(permissionPattern({ ...permission, request: { ...permission.request, detail: undefined } })).toBe("");
  });
  it("upserts questions and escalations through the shared reducer and derives pending totals/status", async () => {
    const client = new DemoClient(() => base); const snapshot = await client.run("run-local-2");
    expect(snapshotInbox(snapshot).map(item => item.kind)).toContain("question");
    expect(summarize(snapshot).pendingTotal).toBe(3);
    const question = snapshot.questions[0]!; const escalation = snapshot.escalations[0]!;
    expect(displayStatus(snapshot.nodes.find(node => node.id === question.nodeId)!, snapshot)).toBe("waiting_answer");
    expect(displayStatus(snapshot.nodes.find(node => node.id === escalation.nodeId)!, snapshot)).toBe("stalled");
    const event: RunEventEnvelope = { type: "question", question: { ...question, status: "answered", answer: "hide", answeredAt: at(2) }, runId: snapshot.run.id, ts: at(2), seq: snapshot.lastSeq + 1 };
    const answered = applyEvent(snapshot, event);
    expect(answered.questions).toHaveLength(1); expect(answered.questions[0]!.answer).toBe("hide");
    const resolved = applyEvent(answered, { type: "escalation", escalation: { ...escalation, status: "resolved", resolution: "dismiss", resolvedAt: at(3) }, runId: snapshot.run.id, ts: at(3), seq: event.seq + 1 });
    expect(resolved.escalations).toHaveLength(2); expect(summarize(resolved).pendingTotal).toBe(1);
    expect(applyEvent(resolved, event)).toBe(resolved);
    expect(sortInbox(snapshotInbox(snapshot)).map(inboxTime)).toEqual(snapshotInbox(snapshot).map(inboxTime));
  });
  it("applies deny before allow, run scope before global, and agent/tool/path constraints", () => {
    const rule = { id: "allow", toolName: "shell", pattern: "npm test", decision: "allow" as const, scope: "global" as const, hits: 0, createdAt: at(0) };
    const deny = { ...rule, id: "deny", decision: "deny" as const };
    const local = { ...rule, id: "local", scope: "run" as const, runId: "r" };
    expect(matchPermissionRule([rule, local], permission, "codex", "/project")?.id).toBe("local");
    expect(matchPermissionRule([rule, local, deny], permission, "codex", "/project")?.id).toBe("deny");
    expect(matchPermissionRule([{ ...rule, agentId: "pi" }], permission, "codex", "/project")).toBeUndefined();
    expect(matchPermissionRule([{ ...rule, pattern: "npm te" }], permission, "codex", "/project")).toBeUndefined();
    const file = { ...permission, request: { ...permission.request, name: "read", detail: { type: "read" as const, filePath: "/project/src/deep/app.ts" } } };
    expect(matchPermissionRule([{ ...rule, toolName: "READ", pattern: "src/**" }], file, "codex", "/project")?.id).toBe("allow");
    expect(matchPermissionRule([{ ...rule, toolName: "read", pattern: "src/*.ts" }], file, "codex", "/project")).toBeUndefined();
  });
});
