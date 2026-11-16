import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "./index.js";

describe("github.ghPath", () => {
  it("clears a configured path when updated with an empty string or null", async () => {
    const store = new Settings(mkdtempSync(join(tmpdir(), "baton-settings-")));
    await store.update({ github: { ghPath: "/opt/gh" } });
    expect((await store.github()).ghPath).toBe("/opt/gh");
    await store.update({ github: { ghPath: "" } });
    expect((await store.github()).ghPath).toBeUndefined();
    await store.update({ github: { ghPath: "/opt/gh2" } });
    await store.update({ github: { ghPath: null as unknown as string } });
    expect((await store.github()).ghPath).toBeUndefined();
  });
});
