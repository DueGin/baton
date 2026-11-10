import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, readToken, SseParser } from "./api.js";
import type { RunEventEnvelope } from "@baton/protocol";

afterEach(() => vi.unstubAllGlobals());
describe("API transport", () => {
  it("extracts the URL token, saves it per session and removes it from the address", () => {
    const values = new Map<string, string>();
    const storage: Storage = { get length() { return values.size; }, clear: () => values.clear(), getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null, removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
    const replaceState = vi.fn();
    expect(readToken({ hash: "#token=secret&keep=yes", pathname: "/", search: "?demo=0" }, storage, { replaceState })).toBe("secret");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?demo=0#keep=yes");
    expect(readToken({ hash: "", pathname: "/", search: "" }, storage)).toBe("secret");
  });
  it("parses fragmented SSE data with CRLF and ignores heartbeat frames", () => {
    const received: RunEventEnvelope[] = []; const parser = new SseParser(event => received.push(event));
    const event: RunEventEnvelope = { type: "log", runId: "r", seq: 2, ts: "2026-11-10T00:00:00Z", level: "info", message: "你好" };
    const stream = `: heartbeat\r\n\r\nid: 2\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
    for (const char of stream) parser.push(char);
    expect(received).toEqual([event]);
  });
  it("sends bearer auth, JSON bodies and encoded IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("local-secret");
    await client.send("node/1", "hello");
    expect(fetchMock).toHaveBeenCalledWith("/api/nodes/node%2F1/messages", { method: "POST", headers: { Authorization: "Bearer local-secret", "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
  });
  it("exposes server error bodies and response status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "invalid token" } }), { status: 401 })));
    await expect(new ApiClient("bad").runs()).rejects.toThrow("401");
  });
});
