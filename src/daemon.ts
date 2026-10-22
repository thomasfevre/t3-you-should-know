import { randomUUID } from "node:crypto";
import type { Backend } from "./backends/index.ts";
import { skipTurns } from "./backoff.ts";
import type { Config } from "./config.ts";
import { parseOutput, type ParseResult } from "./parser.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.ts";
import type { Sink } from "./sinks/index.ts";
import { matchOpenNote, type PendingTurn, type StateStore } from "./state.ts";
import type { T3Sqlite } from "./t3/sqlite.ts";
import { buildTranscript, renderItem, type RawItem } from "./transcript.ts";

export interface Analysis {
  transcript: string;
  raw: string;
  parsed: ParseResult;
  ms: number;
  maxOrdinal: number;
}

/** One model call for one thread: build transcript and prompt, call the backend, parse the answer. */
export async function analyze(
  db: T3Sqlite,
  backend: Backend,
  cfg: Config,
  store: StateStore,
  threadId: string,
): Promise<Analysis> {
  const items = db.items(threadId);
  const transcript = buildTranscript(items, cfg.transcriptBudgetTokens);
  const user = buildUserPrompt({
    transcript,
    recent: store.thread(threadId).recent,
    seen: store.state.seen,
    language: cfg.language,
  });
  const t0 = Date.now();
  const raw = await backend.complete(SYSTEM_PROMPT, user);
  return {
    transcript,
    raw,
    parsed: parseOutput(raw),
    ms: Date.now() - t0,
    maxOrdinal: items.reduce((m, i) => Math.max(m, i.ordinal), 0),
  };
}

function countRenderable(items: RawItem[]): number {
  return items.filter((i) => renderItem(i) !== null).length;
}

/** A turn that fails this many times (model down, T3 unreachable) is dropped with a log line. */
export const MAX_ATTEMPTS = 3;

export class Daemon {
  private running = false;

  private db: T3Sqlite;
  private backend: Backend;
  private sink: Sink;
  private cfg: Config;
  private store: StateStore;
  private log: (msg: string) => void;
  private now: () => Date;

  constructor(
    db: T3Sqlite,
    backend: Backend,
    sink: Sink,
    cfg: Config,
    store: StateStore,
    log: (msg: string) => void = (m) => console.log(`${new Date().toISOString()} ${m}`),
    now: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.backend = backend;
    this.sink = sink;
    this.cfg = cfg;
    this.store = store;
    this.log = log;
    this.now = now;
  }

  async run(): Promise<void> {
    this.running = true;
    // Do not replay history on first start: only runs finishing from now on are analysed.
    this.store.state.lastSeenRunAt ??= this.now().toISOString();
    this.log(`watching runs after ${this.store.state.lastSeenRunAt}`);
    while (this.running) {
      try {
        await this.tick();
      } catch (e: any) {
        this.log(`tick failed: ${e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  stop() {
    this.running = false;
  }

  async tick(): Promise<void> {
    // Feedback first, so a "Got it" given since the last tick shapes this tick's prompts.
    this.syncResolutions();
    this.discoverTurns();
    this.store.save();

    // One pending turn per thread; a later completion replaces an earlier one still waiting.
    for (const [threadId, pending] of Object.entries(this.store.state.pending)) {
      pending.attempts++;
      try {
        await this.onTurnCompleted(threadId, pending);
        delete this.store.state.pending[threadId];
      } catch (e: any) {
        this.log(`thread ${threadId}: attempt ${pending.attempts} failed: ${e?.message ?? e}`);
        if (pending.attempts >= MAX_ATTEMPTS) {
          this.log(`thread ${threadId}: giving up on this turn after ${pending.attempts} attempts`);
          delete this.store.state.pending[threadId];
        }
      }
      this.store.save();
    }
  }

  /** Move the discovery cursor and queue the newest completed run of each thread. */
  private discoverTurns(): void {
    const runs = this.db.terminalRunsSince(this.store.state.lastSeenRunAt!);
    for (const r of runs) {
      this.store.state.lastSeenRunAt = r.completedAt;
      if (r.status !== "completed") continue;
      const current = this.store.state.pending[r.threadId];
      // A note already produced for this thread still goes out; it is not stale after one more turn.
      this.store.state.pending[r.threadId] = {
        ...current,
        completedAt: r.completedAt,
        attempts: 0,
        clientRequestId: current?.clientRequestId ?? randomUUID(),
      };
    }
  }

  /** Throws on model or delivery failure, so the tick keeps the turn pending. */
  private async onTurnCompleted(threadId: string, pending: PendingTurn): Promise<void> {
    const thread = this.db.getThread(threadId);
    if (!thread || thread.archived) return;
    const ts = this.store.thread(threadId);
    if (pending.note) return this.deliver(threadId, thread.title, pending);

    if (ts.skipRemaining > 0) {
      ts.skipRemaining--;
      this.log(`${threadId}: backoff, ${ts.skipRemaining} turns left to skip`);
      return;
    }
    const newItems = this.db.items(threadId, ts.lastOrdinal);
    if (countRenderable(newItems) < this.cfg.minNewItems) {
      this.log(`${threadId}: only ${countRenderable(newItems)} new items, skipped`);
      return;
    }
    if (ts.lastNoteAt) {
      const minutes = (this.now().getTime() - Date.parse(ts.lastNoteAt)) / 60000;
      if (minutes < this.cfg.minMinutesBetweenNotes) {
        this.log(`${threadId}: last note ${minutes.toFixed(1)} min ago, skipped`);
        return;
      }
    }

    const a = await analyze(this.db, this.backend, this.cfg, this.store, threadId);
    this.log(`${threadId}: model answered in ${a.ms} ms (${a.parsed.kind})`);

    if (a.parsed.kind === "note") {
      pending.note = a.parsed.note;
      pending.maxOrdinal = a.maxOrdinal;
      this.store.save();
      return this.deliver(threadId, thread.title, pending);
    }
    // none or invalid: count as a miss so the backoff protects the budget
    ts.lastOrdinal = a.maxOrdinal;
    ts.consecutiveMisses++;
    ts.skipRemaining = skipTurns(ts.consecutiveMisses);
  }

  /** Posts a produced note; the thread's history moves forward only once it is out. */
  private async deliver(threadId: string, title: string, pending: PendingTurn): Promise<void> {
    const note = pending.note!;
    const res = await this.sink.deliver(threadId, title, note, pending.clientRequestId);
    if (!res.delivered) throw new Error("note not delivered");
    const ts = this.store.thread(threadId);
    ts.lastOrdinal = Math.max(ts.lastOrdinal, pending.maxOrdinal ?? 0);
    this.store.addRecent(threadId, note.learn, this.now().toISOString(), res.notificationId);
  }

  /** Feedback loop: close open notes whose resolution has been set in T3. */
  private syncResolutions(): void {
    for (const [threadId, ts] of Object.entries(this.store.state.threads)) {
      if (ts.open.length === 0) continue;
      for (const r of this.db.resolutions(threadId)) {
        const note = matchOpenNote(ts.open, r);
        if (note) {
          this.store.resolve(threadId, note, r.resolution as "acknowledged" | "dismissed" | "asked");
          this.log(`${threadId}: note resolved as ${r.resolution}`);
        }
      }
    }
  }
}
