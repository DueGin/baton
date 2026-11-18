import { describe, expect, it } from "vitest";
import { absolutePath, badgeCount, directoryOptions, externalUrl, notificationRoute, windowChrome } from "./security.js";
describe("desktop IPC validation", () => {
  it("allows browser/mail URLs and rejects executable schemes, credentials and controls", () => {
    for (const url of ["https://github.com/a/b/pull/1", "http://localhost:5173/", "mailto:a@example.test"]) expect(externalUrl(url)).toBe(url);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "shell:AppsFolder", "https://user:password@example.test", "https://example.test\n", null, 4]) expect(() => externalUrl(url)).toThrow();
  });
  it("validates directory inputs and count", () => {
    expect(directoryOptions({ title: "项目" })).toEqual({ title: "项目" }); expect(directoryOptions(undefined)).toEqual({});
    for (const value of [{ defaultPath: "relative" }, { title: 3 }, { properties: ["openFile"] }, []]) expect(() => directoryOptions(value)).toThrow();
    expect(() => absolutePath("relative")).toThrow(); expect(() => absolutePath("/tmp/\0x")).toThrow();
    expect(badgeCount(10000)).toBe(9999); for (const value of [-1, Infinity, 1.5, "2"]) expect(() => badgeCount(value)).toThrow();
  });
  it("routes notifications to internal inbox/run views only", () => {
    expect(notificationRoute("/inbox")).toBe("/inbox"); expect(notificationRoute("/runs/run-1?node=node_2")).toBe("/runs/run-1?node=node_2");
    for (const value of ["https://evil.test", "//evil.test", "/runs/../settings", "/runs/id#javascript", "/api/secret", "/runs/id?token=secret"]) expect(notificationRoute(value)).toBeNull();
  });
  it("accepts only a theme choice and two hex colours for the window chrome", () => {
    expect(windowChrome({ theme: "dark", background: "#181818", foreground: "#E8E8E8" })).toEqual({ theme: "dark", background: "#181818", foreground: "#e8e8e8" });
    for (const value of [null, [], { theme: "auto", background: "#000000", foreground: "#ffffff" }, { theme: "light", background: "red", foreground: "#ffffff" }, { theme: "light", background: "#fff", foreground: "#ffffff" }, { theme: "light", background: "#ffffff", foreground: "#000000", extra: 1 }]) expect(() => windowChrome(value)).toThrow();
  });
});
