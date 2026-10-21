import type { Backend } from "./backends/index.ts";
import { skipTurns } from "./backoff.ts";
import type { Config } from "./config.ts";
import { parseOutput, type ParseResult } from "./parser.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.ts";
import type { Sink } from "./sinks/index.ts";
import type { StateStore } from "./state.ts";
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
    const since = this.store.state.lastSeenRunAt!;
    const runs = this.db.terminalRunsSince(since);
    // One analysis per thread per tick, even if several runs finished.
    const lastRunByThread = new Map<string, (typeof runs)[number]>();
    for (const r of runs) if (r.status === "completed") lastRunByThread.set(r.threadId, r);
    for (const r of runs) this.store.state.lastSeenRunAt = r.completedAt;

    for (const run of lastRunByThread.values()) {
      try {
        await this.onTurnCompleted(run.threadId);
      } catch (e: any) {
        this.log(`thread ${run.threadId}: ${e?.message ?? e}`);
      }
    }
    this.syncResolutions();
    this.store.save();
  }

  private async onTurnCompleted(threadId: string): Promise<void> {
    const thread = this.db.getThread(threadId);
    if (!thread || thread.archived) return;
    const ts = this.store.thread(threadId);

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
    ts.lastOrdinal = a.maxOrdinal;
    this.log(`${threadId}: model answered in ${a.ms} ms (${a.parsed.kind})`);

    if (a.parsed.kind === "note") {
      const delivered = await this.sink.deliver(threadId, thread.title, a.parsed.note);
      if (delivered) {
        this.store.addRecent(threadId, a.parsed.note.learn, this.now().toISOString());
        return;
      }
    }
    // none, invalid, or not delivered: count as a miss so the backoff protects the budget
    ts.consecutiveMisses++;
    ts.skipRemaining = skipTurns(ts.consecutiveMisses);
  }

  /** Feedback loop: close open notes whose resolution has been set in T3. */
  private syncResolutions(): void {
    for (const [threadId, ts] of Object.entries(this.store.state.threads)) {
      if (ts.open.length === 0) continue;
      for (const r of this.db.resolutions(threadId)) {
        if (ts.open.includes(r.summary)) {
          this.store.resolve(threadId, r.summary, r.resolution as "acknowledged" | "dismissed" | "asked");
          this.log(`${threadId}: note resolved as ${r.resolution}`);
        }
      }
    }
  }
}
