import { describe, expect, it } from "vitest";
import type { ItemRecord } from "@baton/protocol";
import { conversationRows, queuedRows, queueDropOrder, queueDropSlot, queueMoveOrder } from "./conversation.js";
const ts = "2026-11-10T07:00:00Z";
const human = (seq: number, delivery: "queued" | "turn" | "steered" | "retracted", turnId?: string, position?: number): ItemRecord => ({ seq, nodeId: "n", ts, turnId, item: { type: "user_message", text: `message ${seq}`, delivery, queuePosition: delivery === "queued" ? position : undefined, deliveryOrder: delivery === "turn" ? position : undefined } });
const assistant = (seq: number, turnId: string): ItemRecord => ({ seq, nodeId: "n", turnId, ts, item: { type: "assistant_message", text: `reply ${seq}` } });

describe("queue ordering and transcript placement", () => {
  it("sorts the dock by queuePosition, excludes other delivery states, and overlays optimistic order", () => {
    const rows = [human(2, "queued", undefined, 3), human(3, "queued", undefined, 1), human(4, "queued", undefined, 2), human(5, "retracted"), human(6, "turn", "t")];
    expect(queuedRows(rows, [], "n").map(entry => entry.row.seq)).toEqual([3, 4, 2]);
    expect(queuedRows(rows, [], "n", [2, 3, 4]).map(entry => entry.row.seq)).toEqual([2, 3, 4]);
    expect(queuedRows(rows, [], "other")).toEqual([]);
  });
  it("places delivered messages immediately before their turn output in deliveryOrder after reload", () => {
    const rows = [assistant(1, "old"), human(2, "turn", "new", 2), human(3, "turn", "new", 1), assistant(4, "old"), assistant(5, "new"), human(6, "queued"), human(7, "retracted")];
    expect(conversationRows(rows, [], "n").map(entry => entry.row.seq)).toEqual([1, 4, 3, 2, 5]);
    expect(conversationRows([human(3, "turn", "new"), human(2, "turn", "new"), assistant(5, "new")], [], "n").map(entry => entry.row.seq)).toEqual([2, 3, 5]);
  });
  it("keeps steered rows at the current turn end and a new turn without output after old output", () => {
    const rows = [assistant(1, "old"), human(2, "steered", "old"), human(3, "turn", "new"), assistant(4, "old")];
    expect(conversationRows(rows, [], "n").map(entry => entry.row.seq)).toEqual([1, 4, 2, 3]);
    expect(conversationRows([human(2, "turn", "empty")], [], "n").map(entry => entry.row.seq)).toEqual([2]);
  });
  it("reconciles a delivered optimistic row by turn and removes its queued duplicate", () => {
    const outgoing = [{ clientId: "c", nodeId: "n", text: "queued then delivered", ts, state: "accepted" as const, itemSeq: 2, delivery: "turn" as const, turnId: "new", deliveryOrder: 1 }];
    const rows = [assistant(1, "old"), assistant(3, "old"), assistant(4, "new")];
    expect(conversationRows(rows, outgoing, "n").map(entry => entry.row.seq)).toEqual([1, 3, 2, 4]);
    expect(queuedRows(rows, outgoing, "n")).toEqual([]);
  });
  it("uses the same ordering for pointer slots and keyboard moves", () => {
    const order = [4, 7, 9];
    expect(queueDropOrder(order, 4, 3)).toEqual([7, 9, 4]);
    expect(queueMoveOrder(order, 4, 1)).toEqual([7, 4, 9]);
    expect(queueMoveOrder(order, 9, -1)).toEqual([4, 9, 7]);
    expect(queueDropOrder(order, 9, 0)).toEqual([9, 4, 7]);
    expect(queueMoveOrder(order, 4, -1)).toBe(order);
    expect(queueMoveOrder(order, 9, 1)).toBe(order);
    expect(queueDropOrder(order, 99, 0)).toBe(order);
    const bounds = [{ top: 100, height: 40 }, { top: 145, height: 50 }, { top: 200, height: 40 }];
    expect([90, 125, 190, 240].map(y => queueDropSlot(y, bounds))).toEqual([0, 1, 2, 3]);
    expect(order).toEqual([4, 7, 9]);
  });
});
