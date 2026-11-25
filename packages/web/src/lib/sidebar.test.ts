import { describe, expect, it } from "vitest";
import { clampSidebarWidth, readSidebar, readSidebarUnreadOnly, saveSidebar, saveSidebarUnreadOnly, sidebarKeyWidth } from "./sidebar.js";
describe("sidebar preferences", () => {
  it("clamps dragging and keyboard widths and resets to the standard 260", () => {
    expect(clampSidebarWidth(20)).toBe(200); expect(clampSidebarWidth(900)).toBe(440); expect(clampSidebarWidth(NaN)).toBe(260);
    expect(sidebarKeyWidth(260, "ArrowLeft")).toBe(250); expect(sidebarKeyWidth(260, "ArrowRight", true)).toBe(300); expect(sidebarKeyWidth(260, "Home")).toBe(200); expect(sidebarKeyWidth(260, "End")).toBe(440);
  });
  it("defaults to a rail on narrow screens and persists both controls", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readSidebar(storage, true)).toEqual({ width: 260, collapsed: true }); expect(readSidebar(storage, false).collapsed).toBe(false);
    saveSidebar(storage, { width: 315, collapsed: true }); expect(readSidebar(storage, false)).toEqual({ width: 315, collapsed: true });
    values.set("baton.sidebarWidth", "900"); expect(readSidebar(storage, false).width).toBe(440);
    expect(readSidebar({ getItem: () => { throw new Error("denied"); } }, true).collapsed).toBe(true);
  });
  it("persists the unread-only filter independently of the sidebar layout", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readSidebarUnreadOnly(storage)).toBe(false);
    saveSidebarUnreadOnly(storage, true);
    expect(values.get("baton.sidebarUnreadOnly")).toBe("true");
    expect(readSidebarUnreadOnly(storage)).toBe(true);
    saveSidebarUnreadOnly(storage, false);
    expect(readSidebarUnreadOnly(storage)).toBe(false);
  });
});
