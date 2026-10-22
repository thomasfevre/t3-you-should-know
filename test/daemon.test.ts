import { describe, expect, it } from "vitest";
import { Daemon, MAX_ATTEMPTS } from "../src/daemon.ts";
import { defaults } from "../src/config.ts";
import { StateStore } from "../src/state.ts";
import type { RawItem } from "../src/transcript.ts";

const NOTE = "learn: Tests were skipped.\ntag: Heads up\n**Tests did not run**\nTwo suites were skipped.";

function fakeDb(runs: { threadId: string; completedAt: string }[], items: RawItem[]) {
  return {
    terminalRunsSince: (since: string) =>
      runs.filter((r) => r.completedAt > since).map((r) => ({ ...r, runId: "r", ordinal: 1, status: "completed" })),
    getThread: (id: string) => ({ threadId: id, title: "T", archived: false }),
    items: (_id: string, after = 0) => items.filter((i) => i.ordinal > after),
    resolutions: () => [],
  } as any;
}

const msg = (n: number): RawItem => ({ type: "user_message", status: "completed", ordinal: n, payload: { text: `m${n}` } });

function setup(backend: { complete: () => Promise<string> }, sink: { deliver: (...a: any[]) => Promise<any> }) {
  const store = new StateStore("/nonexistent/dir/state.json");
  store.save = () => {}; // keep the test off the disk
  store.state.lastSeenRunAt = "2026-01-01T00:00:00.000Z";
  const db = fakeDb([{ threadId: "t1", completedAt: "2026-01-02T00:00:00.000Z" }], [msg(1), msg(2), msg(3), msg(4)]);
  const cfg = { ...defaults(), minNewItems: 1, minMinutesBetweenNotes: 0 };
  const logs: string[] = [];
  const daemon = new Daemon(db, backend as any, sink as any, cfg as any, store, (m) => logs.push(m));
  return { daemon, store, logs };
}

describe("Daemon.tick", () => {
  it("keeps a turn pending when the model fails, and retries it with the same request id", async () => {
    let calls = 0;
    const backend = { complete: async () => { calls++; if (calls === 1) throw new Error("503"); return NOTE; } };
    const delivered: string[] = [];
    const sink = { deliver: async (_t: string, _title: string, _n: unknown, id: string) => { delivered.push(id); return { delivered: true }; } };
    const { daemon, store } = setup(backend, sink);

    await daemon.tick();
    expect(calls).toBe(1);
    expect(store.state.pending.t1?.attempts).toBe(1);
    const id = store.state.pending.t1!.clientRequestId;
    // The cursor moved on; the turn did not get lost with it.
    expect(store.state.lastSeenRunAt).toBe("2026-01-02T00:00:00.000Z");

    await daemon.tick();
    expect(calls).toBe(2);
    expect(delivered).toEqual([id]);
    expect(store.state.pending.t1).toBeUndefined();
    expect(store.thread("t1").open).toHaveLength(1);
  });

  it("gives up on a turn after the attempt cap", async () => {
    const backend = { complete: async () => { throw new Error("down"); } };
    const { daemon, store, logs } = setup(backend, { deliver: async () => ({ delivered: true }) });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await daemon.tick();
    expect(store.state.pending.t1).toBeUndefined();
    expect(logs.some((l) => l.includes("giving up"))).toBe(true);
  });

  it("treats a failed delivery as a retry, not as a miss", async () => {
    const backend = { complete: async () => NOTE };
    const { daemon, store } = setup(backend, { deliver: async () => ({ delivered: false }) });
    await daemon.tick();
    expect(store.state.pending.t1?.attempts).toBe(1);
    expect(store.thread("t1").consecutiveMisses).toBe(0);
  });
});
