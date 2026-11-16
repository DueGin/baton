import { describe, expect, it } from "vitest";
import { parseNotification, SseFrames } from "./events.js";
describe("notification SSE", () => {
  it("handles arbitrary frame boundaries, CRLF and multiline data", () => {
    const received: string[][] = [], frames = new SseFrames((event,data) => received.push([event,data]));
    for (const part of [": heartbeat\r", "\n\r\nevent: notification\r\ndata: {\"id\":", "\"one\"}\r\n\r", "\nevent: changed\ndata: first\ndata: second\n\n"]) frames.push(part);
    expect(received).toEqual([["notification", '{"id":"one"}'], ["changed", "first\nsecond"]]);
  });
  it("validates notices before displaying native UI", () => {
    const notice = { id: "one", kind: "pending", title: "待处理", body: "body", ts: "2026-11-16T00:00:00Z", route: "/inbox" };
    expect(parseNotification(JSON.stringify(notice))).toEqual(notice);
    for (const value of ["{", "null", "{}", JSON.stringify({ ...notice, title: 4 })]) expect(parseNotification(value)).toBeNull();
  });
});
