import { describe, expect, it } from "vitest";
import { clampPanelWidth, panelWidthKey, readPanelWidth, savePanelWidth } from "./panel-width.js";
describe("shared right panel width", () => {
  it("clamps to 280–720 and at most sixty percent of the viewport", () => {
    expect(clampPanelWidth(100, 1400)).toBe(280); expect(clampPanelWidth(900, 1400)).toBe(720);
    expect(clampPanelWidth(700, 900)).toBe(540); expect(clampPanelWidth(320, 400)).toBe(240);
    expect(clampPanelWidth(NaN, 1400)).toBe(320);
  });
  it("persists one preferred width for details and inspector and restores it after narrow mode", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readPanelWidth(storage)).toBe(320); savePanelWidth(storage, 640); expect(values.get(panelWidthKey)).toBe("640");
    expect(clampPanelWidth(readPanelWidth(storage), 700)).toBe(420); expect(clampPanelWidth(readPanelWidth(storage), 1600)).toBe(640);
    values.set(panelWidthKey, "bad"); expect(readPanelWidth(storage)).toBe(320);
    expect(readPanelWidth({ getItem: () => { throw new Error("blocked"); } })).toBe(320);
  });
});
