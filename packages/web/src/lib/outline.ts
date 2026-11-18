import type { QuestionTranscriptEntry } from "./questions.js";
import { parseBatonMessage } from "./baton-messages.js";
import { markdownPlainText } from "./markdown.js";

/** One message the human sent, as shown in the conversation outline rail. */
export interface OutlineItem { seq: number; preview: string; ts: string }

/**
 * Messages the human sent in this conversation, in order. Kernel prompts (baton-tagged assignments,
 * results, notices), queued/retracted messages and rolled-back rows are left out.
 */
export function outlineItems(entries: QuestionTranscriptEntry[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const entry of entries) {
    if (entry.type !== "row") continue;
    const { row, outgoing } = entry.entry; const item = row.item;
    if (item.type !== "user_message" || row.rolledBack || row.seq <= 0) continue;
    if (["queued", "retracted"].includes(item.delivery ?? "")) continue;
    // Kernel prompts (assignments, results, notices, follow-ups) are baton-tagged and carry no delivery.
    if (!item.delivery && !outgoing && (/^\s*<baton-[a-z]+\b/.test(item.text) || parseBatonMessage(item.text))) continue;
    items.push({ seq: row.seq, preview: markdownPlainText(item.text) || "（图片）", ts: row.ts });
  }
  return items;
}

/**
 * Index of the message the reader is at: the last one whose top has scrolled above a reading line
 * a third of the way down the viewport (the first message when none has).
 */
export function activeOutlineIndex(tops: number[], viewportTop: number, viewportHeight: number): number {
  const line = viewportTop + viewportHeight / 3; let active = 0;
  tops.forEach((top, index) => { if (top <= line) active = index; });
  return active;
}
