import { describe, expect, it } from "vitest";
import { cssColorHex, desktopRoute } from "./desktop.js";

describe("desktop helpers", () => {
  it("turns computed colours into the hex the window chrome IPC accepts", () => {
    expect(cssColorHex("rgb(24, 24, 24)")).toBe("#181818");
    expect(cssColorHex("rgba(247, 247, 247, 1)")).toBe("#f7f7f7");
    expect(cssColorHex("rgb(255,0,10)")).toBe("#ff000a");
    for (const value of ["rgba(0, 0, 0, 0)", "transparent", "#181818", "color(srgb 1 0 0)", ""]) expect(cssColorHex(value)).toBeNull();
  });
  it("maps notification routes to console pages", () => {
    expect(desktopRoute("/inbox", "")).toEqual({ page: "inbox" });
    expect(desktopRoute("/runs/run-1", "?node=n_2")).toEqual({ page: "runs", runId: "run-1", nodeId: "n_2" });
    expect(desktopRoute("/runs/../x", "")).toBeNull();
  });
});
