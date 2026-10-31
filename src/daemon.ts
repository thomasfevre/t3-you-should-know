import { randomUUID } from "node:crypto";
import type { Backend } from "./backends/index.ts";
import { skipTurns } from "./backoff.ts";
import type { Config } from "./config.ts";
import { parseOutput, type ParseResult } from "./parser.ts";
import { alreadyShown, EXPIRE_AFTER_DAYS, EXPIRE_AFTER_RUNS, type InlineDb } from "./inline.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.ts";
import { takeQueued } from "./queue.ts";
import { readDisabled } from "./toggle.ts";
import type { Sink } from "./sinks/index.ts";
import type { PendingTurn, StateStore } from "./state.ts";
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
    this.checkSchema();
    while (this.running) {
      try {
        await this.tick();
      } catch (e: any) {
        this.log(`tick failed: ${e?.message ?? e}`);
        this.checkSchema();
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  /** Loud log line when T3's internal tables no longer look like what this tool reads. */
  private checkSchema(): void {
    const db = this.db as Partial<T3Sqlite>;
    if (!db.schemaProblems) return;
    try {
      const problems = db.schemaProblems();
      if (problems.length) this.log(`T3 FORMAT CHANGED, notes will not work: ${problems.join("; ")}`);
    } catch (e: any) {
      this.log(`T3 FORMAT CHECK FAILED: ${e?.message ?? e}`);
    }
  }

  stop() {
    this.running = false;
  }

  async tick(): Promise<void> {
    this.reconcileInbox();
    this.discoverTurns();
    await this.deliverQueued();
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
    const disabled = readDisabled(this.cfg.statePath);
    for (const r of runs) {
      this.store.state.lastSeenRunAt = r.completedAt;
      if (r.status !== "completed") continue;
      if (this.cfg.onlyThreads && !this.cfg.onlyThreads.includes(r.threadId)) continue;
      if (disabled.has(r.threadId)) continue;
      const current = this.store.state.pending[r.threadId];
      // A note already produced for this thread still goes out, with its attempts so far; it is
      // not stale after one more turn. Only a turn with no note yet starts a fresh count.
      this.store.state.pending[r.threadId] = current?.note
        ? { ...current, completedAt: r.completedAt }
        : { completedAt: r.completedAt, attempts: 0, clientRequestId: current?.clientRequestId ?? randomUUID() };
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
    this.store.addRecent(threadId, note.learn, this.now().toISOString());
  }

  /** Notes handed over with `t3-ysk queue`: delivered now, no model call, no rate limit. */
  private async deliverQueued(): Promise<void> {
    for (const q of takeQueued(this.cfg.statePath)) {
      const thread = this.db.getThread(q.threadId);
      const res = await this.sink.deliver(q.threadId, thread?.title ?? "", q.note, randomUUID());
      if (res.delivered) this.store.addRecent(q.threadId, q.note.learn, this.now().toISOString());
      this.log(`${q.threadId}: queued note ${res.delivered ? "delivered" : "NOT delivered"}`);
    }
  }

  /** `inline` sink: drop queued notes that are now in the thread, or that expired. */
  private reconcileInbox(): void {
    const db = this.db as unknown as Partial<InlineDb>;
    if (!db.assistantTextsAfter || !db.completedRunsAfter) return;
    const disabled = readDisabled(this.cfg.statePath);
    for (const [threadId, notes] of Object.entries(this.store.state.inbox)) {
      const keep = notes.filter((n) => {
        if (disabled.has(threadId)) return false;
        if (alreadyShown(db as InlineDb, threadId, n)) {
          this.log(`${threadId}: note shown in chat (${n.noteId})`);
          return false;
        }
        const runs = db.completedRunsAfter!(threadId, n.runWatermark);
        const days = (this.now().getTime() - Date.parse(n.createdAt)) / 86_400_000;
        if (runs >= EXPIRE_AFTER_RUNS || days >= EXPIRE_AFTER_DAYS) {
          this.log(`${threadId}: note expired unseen after ${runs} runs (${n.noteId})`);
          return false;
        }
        return true;
      });
      if (keep.length) this.store.state.inbox[threadId] = keep;
      else delete this.store.state.inbox[threadId];
    }
  }

}
