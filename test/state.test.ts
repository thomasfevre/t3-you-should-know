import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchOpenNote, MAX_RECENT, StateStore } from "../src/state.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "ysk-test-")), "sub", "state.json");

describe("StateStore", () => {
  it("persists and reloads", () => {
    const path = tmp();
    const a = new StateStore(path);
    a.addRecent("t1", "learn one.", "2026-01-01T00:00:00Z");
    a.save();
    const b = new StateStore(path);
    expect(b.thread("t1").recent).toEqual(["learn one."]);
    expect(b.thread("t1").open).toEqual([{ learn: "learn one." }]);
  });

  it("caps recent suggestions at 10 and resets misses on a note", () => {
    const s = new StateStore(tmp());
    s.thread("t").consecutiveMisses = 5;
    for (let i = 0; i < 15; i++) s.addRecent("t", `l${i}`, "x");
    expect(s.thread("t").recent).toHaveLength(MAX_RECENT);
    expect(s.thread("t").recent.at(-1)).toBe("l14");
    expect(s.thread("t").consecutiveMisses).toBe(0);
  });

  it("only acknowledged resolutions feed the global seen list", () => {
    const s = new StateStore(tmp());
    s.addRecent("t", "a.", "x");
    s.addRecent("t", "b.", "x");
    const [a, b] = s.thread("t").open;
    s.resolve("t", a, "acknowledged");
    s.resolve("t", b, "dismissed");
    expect(s.state.seen).toEqual(["a."]);
    expect(s.thread("t").open).toEqual([]);
  });

  it("starts fresh on a corrupt file", () => {
    const path = tmp();
    const s = new StateStore(path);
    s.save();
    
    writeFileSync(path, "{nope");
    expect(new StateStore(path).state.seen).toEqual([]);
  });
});

describe("matchOpenNote", () => {
  const open = [
    { learn: "same text.", notificationId: "n1" },
    { learn: "same text.", notificationId: "n2" },
    { learn: "legacy.", },
  ];

  it("prefers the notification id over identical summaries", () => {
    expect(matchOpenNote(open, { itemId: "n2", summary: "same text." })).toBe(open[1]);
    expect(matchOpenNote(open, { itemId: "x", payloadId: "n1", summary: "same text." })).toBe(open[0]);
  });

  it("falls back to summary only for notes without an id", () => {
    expect(matchOpenNote(open, { itemId: "x", summary: "legacy." })).toBe(open[2]);
    expect(matchOpenNote(open, { itemId: "x", summary: "same text." })).toBeUndefined();
  });
});
