import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenu, contextMenuPosition, nextMenuItem } from "./ContextMenu.js";

describe("ContextMenu", () => {
  it("renders labeled menu items and a separator", () => {
    const html = renderToStaticMarkup(<ContextMenu x={10} y={20} label="会话操作" close={vi.fn()} entries={[
      { label: "重命名", action: vi.fn() },
      { label: "复制会话 ID", action: vi.fn() },
      { separator: true },
      { label: "归档", action: vi.fn(), danger: true },
    ]} />);
    expect(html).toContain('role="menu" aria-label="会话操作"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html).toMatch(/重命名.*复制会话 ID.*role="separator".*归档/);
    expect(html).toContain("is-danger");
  });

  it("keeps the menu within the viewport, even at the edges", () => {
    const position = (x: number, y: number) => contextMenuPosition(x, y, 160, 100, 320, 240);
    expect(position(10, 20)).toEqual({ left: 10, top: 20 });
    expect(position(319, 239)).toEqual({ left: 156, top: 136 });
    expect(position(-10, -20)).toEqual({ left: 4, top: 4 });
  });

  it("wraps arrow navigation and supports Home and End", () => {
    expect(nextMenuItem("ArrowDown", 2, 3)).toBe(0);
    expect(nextMenuItem("ArrowUp", 0, 3)).toBe(2);
    expect(nextMenuItem("Home", 2, 3)).toBe(0);
    expect(nextMenuItem("End", 0, 3)).toBe(2);
    expect(nextMenuItem("ArrowDown", -1, 3)).toBe(0);
    expect(nextMenuItem("ArrowUp", -1, 3)).toBe(2);
    expect(nextMenuItem("ArrowDown", -1, 0)).toBeUndefined();
    expect(nextMenuItem("Enter", 0, 3)).toBeUndefined();
  });
});
