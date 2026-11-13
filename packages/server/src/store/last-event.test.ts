import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsage } from "@baton/protocol";
import { Store } from "./index.js";

describe("snapshot.lastEventAt", () => {
  it("is the timestamp of the latest event and appears in run summaries", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "baton-store-")), "baton.db"));
    const ts = "2026-11-13T00:00:00.000Z";
    store.append("r1", { type: "run.created", run: { id: "r1", title: "t", titleSource: "generated", cwd: "/", status: "active", rootNodeId: "n1", policy: { maxDepth: 3, maxActiveChildren: 6, autoApprove: false }, createdAt: ts, updatedAt: ts, usage: emptyUsage() } });
    const second = store.append("r1", { type: "log", level: "info", message: "x" });
    const snapshot = store.snapshot("r1");
    expect(snapshot.lastSeq).toBe(2);
    expect(snapshot.lastEventAt).toBe(second.ts);
    const summary = store.list().find((r) => r.id === "r1");
    expect(summary?.titleSource).toBe("generated");
    expect(summary?.lastEventAt).toBe(second.ts);
    store.close();
  });
});
