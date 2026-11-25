import { describe, expect, it } from "vitest";
import { isActivityEvent } from "@baton/protocol";
import { filterUnreadRuns, isUnread, markRunSeen, mergeRunSeen, mergeRunSeenStorage, readRunSeen, reconcileRunSeen, runActivityAt, runSeenKey, saveRunSeen, setRunRead, summarizeUnread } from "./unread.js";

const first = "2026-11-15T01:00:00.000Z";
const second = "2026-11-15T02:00:00.000Z";
const third = "2026-11-15T03:00:00.000Z";
const atlas = { id: "run-atlas", projectId: "atlas", updatedAt: second, lastEventAt: first };
const notes = { id: "run-notes", projectId: "notes", updatedAt: first };
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

describe("run unread state", () => {
  it("round-trips ISO timestamps, distinguishing an empty stored map from first load", () => {
    const storage = memoryStorage();
    expect(readRunSeen(storage)).toBeNull();
    saveRunSeen(storage, new Map());
    expect(readRunSeen(storage)).toEqual(new Map());
    storage.setItem(runSeenKey, JSON.stringify({ [atlas.id]: first, invalid: "yesterday", number: 5 }));
    const seen = readRunSeen(storage)!;
    expect(seen).toEqual(new Map([[atlas.id, first]]));
    saveRunSeen(storage, seen);
    expect(JSON.parse(storage.getItem(runSeenKey)!)).toEqual({ [atlas.id]: first });
    storage.setItem(runSeenKey, "[]");
    expect(readRunSeen(storage)).toBeNull();
    const denied = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readRunSeen(denied)).toBeNull();
    expect(() => saveRunSeen(denied, seen)).not.toThrow();
  });

  it("merges per-run timestamps by their latest instant without changing either input", () => {
    const local = new Map([[atlas.id, first], [notes.id, third], ["local-only", first]]);
    const incoming = new Map([[atlas.id, "2026-11-14T21:00:00-05:00"], [notes.id, second], ["other-tab", first]]);
    expect(mergeRunSeen(local, incoming)).toEqual(new Map([[atlas.id, incoming.get(atlas.id)], [notes.id, third], ["local-only", first], ["other-tab", first]]));
    expect(local.get(atlas.id)).toBe(first);
    expect(incoming.get(notes.id)).toBe(second);
    expect(mergeRunSeen(local, new Map([[atlas.id, first]]))).toBe(local);
  });

  it("preserves another tab's read marks until reconciling with a loaded run list", () => {
    const storage = memoryStorage();
    saveRunSeen(storage, new Map([[atlas.id, third], ["removed", first]]));
    const otherTab = new Map([[atlas.id, second], [notes.id, first]]);
    saveRunSeen(storage, otherTab);
    expect(readRunSeen(storage)).toEqual(new Map([[atlas.id, third], ["removed", first], [notes.id, first]]));
    saveRunSeen(storage, otherTab, { runs: [atlas, notes] });
    expect(readRunSeen(storage)).toEqual(new Map([[atlas.id, third], [notes.id, first]]));
  });

  it("merges storage events by max and ignores unrelated or invalid events", () => {
    const local = new Map([[atlas.id, third], ["local-only", first]]);
    const event = { key: runSeenKey, oldValue: JSON.stringify(Object.fromEntries(local)), newValue: JSON.stringify({ [atlas.id]: second, [notes.id]: first }) };
    expect(mergeRunSeenStorage(local, event)).toEqual(new Map([...local, [notes.id, first]]));
    expect(mergeRunSeenStorage(local, { ...event, key: "other" })).toBe(local);
    expect(mergeRunSeenStorage(local, { ...event, newValue: "invalid" })).toBe(local);
  });

  it("syncs a manual mark-unread without discarding newer read marks in another tab", () => {
    const storage = memoryStorage();
    const local = new Map([[atlas.id, first], [notes.id, second]]);
    saveRunSeen(storage, local);
    const oldValue = storage.getItem(runSeenKey);
    const unread = saveRunSeen(storage, local, { markUnread: atlas });
    const event = { key: runSeenKey, oldValue, newValue: storage.getItem(runSeenKey) };
    expect(isUnread(atlas, unread)).toBe(true);
    expect(readRunSeen(storage)).toEqual(new Map([[notes.id, second]]));
    expect(isUnread(atlas, mergeRunSeenStorage(local, event))).toBe(true);
    const newer = markRunSeen(local, atlas.id, third);
    expect(mergeRunSeenStorage(newer, event)).toBe(newer);
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

  it("tracks viewed activity continuously but leaves subsequent activity unread when not viewed", () => {
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

  it("excludes background, PR and cosmetic events from conversation activity", () => {
    expect(isActivityEvent({ type: "background" })).toBe(false);
    expect(isActivityEvent({ type: "pr" })).toBe(false);
    expect(isActivityEvent({ type: "item" })).toBe(true);
    expect(isActivityEvent({ type: "run.updated", patch: { status: "idle" } })).toBe(true);
    expect(isActivityEvent({ type: "run.updated", patch: { title: "x", updatedAt: third } })).toBe(false);
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
