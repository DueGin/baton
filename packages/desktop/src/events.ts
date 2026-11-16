import type { NotificationEvent } from "@baton/protocol";
import type { DaemonConnection } from "./daemon.js";

/** SSE frame decoder works with CRLF and arbitrary UTF-8/network chunk boundaries. */
export class SseFrames {
  private buffer = "";
  constructor(private readonly frame: (event: string, data: string) => void) {}
  push(text: string): void {
    this.buffer += text;
    if (this.buffer.length > 2 * 1024 * 1024) throw new Error("SSE frame too large");
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(this.buffer); if (!match || match.index === undefined) break;
      const lines = this.buffer.slice(0, match.index).split(/\r?\n/u); this.buffer = this.buffer.slice(match.index + match[0].length);
      let event = "message"; const data: string[] = [];
      for (const line of lines) { if (line.startsWith("event:")) event = line.slice(6).trim(); if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, "")); }
      if (data.length) this.frame(event, data.join("\n"));
    }
  }
}

export function parseNotification(data: string): NotificationEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object") return null;
    const notice = value as Record<string, unknown>;
    if (typeof notice.id !== "string" || typeof notice.title !== "string" || typeof notice.body !== "string" || typeof notice.ts !== "string" || !["pending", "run_completed", "pr", "other"].includes(String(notice.kind))) return null;
    if (notice.route !== undefined && typeof notice.route !== "string") return null;
    return value as NotificationEvent;
  } catch { return null; }
}

export function subscribe(connection: DaemonConnection, path: string, frame: (event: string, data: string) => void, signal: AbortSignal): void {
  void (async () => {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await fetch(`${connection.url}${path}`, { headers: { authorization: `Bearer ${connection.token}`, accept: "text/event-stream" }, signal });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("SSE unavailable");
        failures = 0;
        const frames = new SseFrames(frame), decoder = new TextDecoder();
        for await (const chunk of response.body) frames.push(decoder.decode(chunk, { stream: true }));
      } catch { /* Includes older daemons without the notification endpoint (404). */ }
      if (signal.aborted) break;
      await new Promise<void>(done => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); };
        const timer = setTimeout(finish, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  })();
}
