import { describe, expect, it } from "vitest";
import { matchesSession, overflowEdges, overflows, scrollStep } from "./session-tabs.js";

describe("session tab overflow", () => {
  it("compares content to the whole bar before taking space for controls", () => {
    expect(overflows(501, 500)).toBe(false);
    expect(overflows(502, 500)).toBe(true);
    expect(overflows(450, 500)).toBe(false);
  });

  it.each([
    [-2, false, true], [1, false, true], [1.25, true, true],
    [98.75, true, true], [99, true, false], [103, true, false],
  ] as const)("computes hidden sides at offset %s with one pixel of tolerance", (left, before, after) => {
    expect(overflowEdges(left, 300, 200)).toEqual({ left: before, right: after });
  });

  it("shows neither edge when everything fits, even during overscroll", () => {
    expect(overflowEdges(12, 160, 200)).toEqual({ left: false, right: false });
    expect(overflowEdges(-3, 201, 200)).toEqual({ left: false, right: false });
  });

  it("pages by four fifths of the visible width in either direction", () => {
    expect(scrollStep(450, 1)).toBe(360);
    expect(scrollStep(201, -1)).toBe(-161);
  });
});

describe("session filtering", () => {
  const node = { id: "node-42", role: "Review", title: "核对接口", agentId: "Codex" };
  it("matches across role, agent, title and id, ignoring case and extra spaces", () => {
    expect(matchesSession(node, "  rev  CODE 接口 42 ")).toBe(true);
    expect(matchesSession(node, "review 发布")).toBe(false);
  });
  it("keeps all nodes for an empty query and searches nodes without roles", () => {
    expect(matchesSession(node, "   ")).toBe(true);
    expect(matchesSession({ ...node, role: undefined }, "核对")).toBe(true);
  });
});
