import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentProblem, imageSource, ImageUrlCache, joinPath } from "./images.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("image sources", () => {
  it("recognizes attachment markers and refuses malformed ids", () => {
    expect(imageSource("attachment:att_123")).toEqual({ kind: "attachment", id: "att_123" });
    expect(imageSource("ATTACHMENT:att-1.v2")).toEqual({ kind: "attachment", id: "att-1.v2" });
    for (const bad of ["attachment:", "attachment:../etc/passwd", "attachment:a b", "attachment:a%2Fb"]) expect(imageSource(bad)).toBeNull();
  });
  it("serves absolute and file:// image paths through the local file endpoint, decoding what Markdown encoded", () => {
    expect(imageSource("/Users/me/proj/shot.png")).toEqual({ kind: "local", path: "/Users/me/proj/shot.png" });
    expect(imageSource("/Users/me/%E6%88%AA%E5%9B%BE%201.PNG")).toEqual({ kind: "local", path: "/Users/me/截图 1.PNG" });
    expect(imageSource("file:///tmp/a%20b.jpeg")).toEqual({ kind: "local", path: "/tmp/a b.jpeg" });
    expect(imageSource("file://localhost/tmp/a.webp")).toEqual({ kind: "local", path: "/tmp/a.webp" });
    expect(imageSource("file:///C:/shots/a.gif")).toEqual({ kind: "local", path: "C:/shots/a.gif" });
    expect(imageSource("C:\\shots\\a.png")).toEqual({ kind: "local", path: "C:\\shots\\a.png" });
  });
  it("resolves relative paths against the node cwd only when one is known", () => {
    expect(imageSource("docs/shot.png", "/workspace/notes")).toEqual({ kind: "local", path: "/workspace/notes/docs/shot.png" });
    expect(imageSource("./a/../b/c.jpg", "/w/p/")).toEqual({ kind: "local", path: "/w/p/b/c.jpg" });
    expect(imageSource("../../../../x.png", "/w")).toEqual({ kind: "local", path: "/x.png" });
    expect(imageSource("docs/shot.png")).toBeNull();
    expect(imageSource("docs/shot.png", "relative/cwd")).toBeNull();
    expect(joinPath("C:\\proj", "img\\a.png")).toBe("C:\\proj\\img\\a.png");
  });
  it("loads http(s) and base64 raster data URLs directly", () => {
    expect(imageSource("https://example.com/a.png?x=1")).toEqual({ kind: "remote", url: "https://example.com/a.png?x=1" });
    expect(imageSource("http://127.0.0.1:5173/shot")).toEqual({ kind: "remote", url: "http://127.0.0.1:5173/shot" });
    expect(imageSource("data:image/png;base64,iVBORw0KGgo=")).toEqual({ kind: "data", url: "data:image/png;base64,iVBORw0KGgo=" });
    expect(imageSource("data:image/webp;base64,UklGRg==")?.kind).toBe("data");
  });
  it("refuses everything else", () => {
    for (const unsafe of [
      "javascript:alert(1)", " javascript:alert(1)", "JaVaScRiPt:x", "vbscript:x", "blob:https://x/1", "mailto:a@b.c",
      "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGI+", "data:image/png,rawbytes", "data:image/png;base64,<svg>",
      "//evil.example/x.png", "\\\\server\\share\\x.png", "~/x.png", "/etc/passwd", "/tmp/x.svg", "file:///etc/passwd", "file://host/x.png",
      "https://a b/x.png", "/tmp/a\u0000.png", "", "   ",
    ]) expect(imageSource(unsafe, "/workspace"), unsafe).toBeNull();
  });
  it("accepts only the attachment MIME types up to the size limit", () => {
    expect(attachmentProblem({ type: "image/png", size: 10 })).toBeNull();
    expect(attachmentProblem({ type: "image/svg+xml", size: 10 })).toContain("仅支持");
    expect(attachmentProblem({ type: "image/jpeg", size: 21 * 1024 * 1024 })).toContain("MB");
  });
});

describe("image URL cache", () => {
  it("shares one fetch per key, keeps it while leased and revokes it after the linger", async () => {
    vi.useFakeTimers();
    let serial = 0; const revoked: string[] = [];
    vi.stubGlobal("URL", { createObjectURL: () => `blob:${++serial}`, revokeObjectURL: (url: string) => { revoked.push(url); } });
    const cache = new ImageUrlCache(1000); const load = vi.fn(async () => new Blob(["x"]));
    const first = cache.acquire("attachment:a", load); const second = cache.acquire("attachment:a", load);
    expect(await first.promise).toBe("blob:1"); expect(await second.promise).toBe("blob:1"); expect(load).toHaveBeenCalledTimes(1);
    first.release(); first.release(); vi.advanceTimersByTime(5000); expect(revoked).toEqual([]);
    second.release(); vi.advanceTimersByTime(500);
    const again = cache.acquire("attachment:a", load); vi.advanceTimersByTime(5000); expect(revoked).toEqual([]); expect(load).toHaveBeenCalledTimes(1);
    again.release(); vi.advanceTimersByTime(1000); expect(revoked).toEqual(["blob:1"]); expect(cache.has("attachment:a")).toBe(false);
  });
  it("forgets failed loads so a later render retries, and serves seeded uploads without fetching", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:seeded", revokeObjectURL: () => undefined });
    const cache = new ImageUrlCache(1000);
    const failing = cache.acquire("file:/x.png", () => Promise.reject(new Error("404")));
    await expect(failing.promise).rejects.toThrow("404"); expect(cache.has("file:/x.png")).toBe(false);
    cache.seed("attachment:new", new Blob(["x"])); const load = vi.fn(async () => new Blob());
    expect(await cache.acquire("attachment:new", load).promise).toBe("blob:seeded"); expect(load).not.toHaveBeenCalled();
  });
});
