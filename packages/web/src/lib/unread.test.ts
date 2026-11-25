import { describe, expect, it } from "vitest";
import { filterUnreadRuns, isUnread, markRunSeen, readRunSeen, reconcileRunSeen, runActivityAt, saveRunSeen, setRunRead, summarizeUnread } from "./unread.js";

const first = "2026-11-15T01:00:00.000Z";
const second = "2026-11-15T02:00:00.000Z";
const third = "2026-11-15T03:00:00.000Z";
const atlas = { id: "run-atlas", projectId: "atlas", updatedAt: second, lastEventAt: first };
const notes = { id: "run-notes", projectId: "notes", updatedAt: first };

describe("run unread state", () => {
  it("round-trips ISO timestamps, distinguishing an empty stored map from first load", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readRunSeen(storage)).toBeNull();
    saveRunSeen(storage, new Map());
    expect(readRunSeen(storage)).toEqual(new Map());
    values.set("baton.runSeen", JSON.stringify({ [atlas.id]: first, invalid: "yesterday", number: 5 }));
    const seen = readRunSeen(storage)!;
    expect(seen).toEqual(new Map([[atlas.id, first]]));
    saveRunSeen(storage, seen);
    expect(JSON.parse(values.get("baton.runSeen")!)).toEqual({ [atlas.id]: first });
    values.set("baton.runSeen", "[]");
    expect(readRunSeen(storage)).toBeNull();
    const denied = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readRunSeen(denied)).toBeNull();
    expect(() => saveRunSeen(denied, seen)).not.toThrow();
  });

  it("seeds only on the first completed load and prunes only against the loaded list", () => {
    expect(reconcileRunSeen(null, [], true)).toBeNull();
    const seen = reconcileRunSeen(null, [atlas], false)!;
    expect(seen).toEqual(new Map([[atlas.id, first]]));
    expect(reconcileRunSeen(seen, [], true)).toBe(seen);
    expect(reconcileRunSeen(seen, [atlas, notes], false)).toBe(seen);
    expect(isUnread(atlas, seen)).toBe(false);
    expect(isUnread(notes, seen)).toBe(true);
    expect(reconcileRunSeen(seen, [notes], false)).toEqual(new Map());
    expect(reconcileRunSeen(new Map(), [notes], false)).toEqual(new Map());
  });

  it("uses lastEventAt over updatedAt, with strict comparison and a fallback for older servers", () => {
    const seen = new Map([[atlas.id, first], [notes.id, first]]);
    expect(isUnread(atlas, seen)).toBe(false);
    expect(isUnread({ ...atlas, lastEventAt: second }, seen)).toBe(true);
    expect(isUnread({ ...notes, updatedAt: second }, seen)).toBe(true);
    expect(isUnread(atlas, new Map([[atlas.id, "2026-11-15T09:00:00+08:00"]]))).toBe(false);
    expect(isUnread({ ...atlas, updatedAt: third, lastEventAt: third, lastActivityAt: first }, seen)).toBe(false);
    expect(isUnread({ ...atlas, updatedAt: third, lastEventAt: third, lastActivityAt: second }, seen)).toBe(true);
  });

  it("tracks viewed activity continuously but leaves subsequent background events unread", () => {
    const initial = new Map([[atlas.id, first]]);
    const active = { ...atlas, lastEventAt: second };
    const read = markRunSeen(initial, active.id, runActivityAt(active));
    expect(read.get(atlas.id)).toBe(second);
    expect(isUnread(active, read)).toBe(false);
    expect(isUnread(notes, read)).toBe(true);
    expect(markRunSeen(read, atlas.id, runActivityAt(atlas))).toBe(read);
    const next = { ...active, lastEventAt: third };
    expect(isUnread(next, reconcileRunSeen(read, [next, notes], false))).toBe(true);
    expect(isUnread(next, markRunSeen(read, next.id, runActivityAt(next)))).toBe(false);
    expect(markRunSeen(read, notes.id, runActivityAt(notes)).get(notes.id)).toBe(first);
  });

  it("marks a run unread or read without mutating the saved map", () => {
    const seen = new Map([[atlas.id, first]]);
    const unread = setRunRead(seen, atlas, false);
    expect(isUnread(atlas, seen)).toBe(false);
    expect(isUnread(atlas, unread)).toBe(true);
    expect(isUnread(atlas, setRunRead(unread, atlas, true))).toBe(false);
  });

  it("counts unread by project and filters while keeping the selected run", () => {
    const legacy = { id: "legacy", updatedAt: first };
    const readNotes = { ...notes, id: "read-notes" };
    const runs = [atlas, legacy, readNotes, notes];
    const unread = summarizeUnread(runs, new Map([[atlas.id, first], [readNotes.id, first]]));
    expect(unread.ids).toEqual(new Set([legacy.id, notes.id]));
    expect(unread.byProject).toEqual(new Map([[notes.projectId, 1]]));
    expect(filterUnreadRuns(runs, unread.ids, atlas.id)).toEqual([atlas, legacy, notes]);
    expect(filterUnreadRuns(runs, new Set(), null)).toEqual([]);
  });
});
