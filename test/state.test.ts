import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_RECENT, StateStore } from "../src/state.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "ysk-test-")), "sub", "state.json");

describe("StateStore", () => {
  it("persists and reloads", () => {
    const path = tmp();
    const a = new StateStore(path);
    a.addRecent("t1", "learn one.", "2026-01-01T00:00:00Z");
    a.save();
    const b = new StateStore(path);
    expect(b.thread("t1").recent).toEqual(["learn one."]);
    expect(b.thread("t1").open).toEqual(["learn one."]);
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
    s.resolve("t", "a.", "acknowledged");
    s.resolve("t", "b.", "dismissed");
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
