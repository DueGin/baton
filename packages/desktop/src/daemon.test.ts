import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonAddress, discoverDaemon } from "./daemon.js";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
describe("daemon discovery", () => {
  it("rejects non-loopback, malformed, mismatched and credentialed addresses", () => {
    for (const url of ["https://127.0.0.1:7433", "http://evil.test:7433", "http://user@127.0.0.1:7433", "http://127.0.0.1:7433/path", "http://127.0.0.1:7433?token=secret", "file:///tmp/daemon", "http://127.0.0.1:7434"]) expect(daemonAddress({ url, port: 7433 })).toBeNull();
    expect(daemonAddress({ url: "http://127.0.0.1:7433", port: 7433 })).toEqual({ url: "http://127.0.0.1:7433", port: 7433 });
  });
  it("verifies auth, service identity and exact data home rather than trusting a descriptor", async () => {
    const home = await mkdtemp(join(tmpdir(), "baton-desktop-discover-")); homes.push(home);
    const token = "a".repeat(64);
    await writeFile(join(home, "token"), token); await writeFile(join(home, "daemon.json"), JSON.stringify({ url: "http://127.0.0.1:48123", port: 48123 }));
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ name: "baton", home, port: 48123 }));
    expect(await discoverDaemon(home, request)).toEqual({ url: "http://127.0.0.1:48123", port: 48123, token });
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ authorization: `Bearer ${token}` });
    for (const info of [{ name: "other", home, port: 48123 }, { name: "baton", home: `${home}/different`, port: 48123 }, { name: "baton", home, port: 48124 }]) {
      request.mockResolvedValueOnce(Response.json(info)); expect(await discoverDaemon(home, request)).toBeNull();
    }
    request.mockRejectedValueOnce(new Error("connection refused")); expect(await discoverDaemon(home, request)).toBeNull();
  });
  it("tolerates missing and corrupt files without making network calls", async () => {
    const home = await mkdtemp(join(tmpdir(), "baton-desktop-discover-")); homes.push(home); const request = vi.fn<typeof fetch>();
    expect(await discoverDaemon(home, request)).toBeNull();
    await writeFile(join(home, "token"), "a".repeat(64)); await writeFile(join(home, "daemon.json"), "garbage");
    expect(await discoverDaemon(home, request)).toBeNull(); expect(request).not.toHaveBeenCalled();
  });
});
