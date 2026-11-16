import { describe, expect, it } from "vitest";
import { windowState } from "./window-state.js";
const displays = [{ x: 0, y: 0, width: 1440, height: 900 }, { x: -1920, y: 0, width: 1920, height: 1080 }];
describe("window state", () => {
  it("restores visible windows on secondary displays", () => {
    expect(windowState({ x: -1500, y: 10, width: 1000, height: 800, maximized: true }, displays)).toEqual({ x: -1500, y: 10, width: 1000, height: 800, maximized: true });
  });
  it("drops offscreen coordinates and clamps malformed dimensions", () => {
    expect(windowState({ x: 6000, y: 4000, width: 10, height: 9000 }, displays)).toEqual({ width: 800, height: 2160, maximized: false });
    expect(windowState({ width: NaN, height: Infinity }, displays)).toEqual({ width: 1320, height: 900, maximized: false });
  });
});
