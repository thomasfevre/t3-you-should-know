import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InboxNote } from "./inline.ts";
import type { Note } from "./parser.ts";

export interface ThreadState {
  /** Last "learn:" lines offered on this thread, newest last, max 10. */
  recent: string[];
  consecutiveMisses: number;
  /** Turns still to skip before asking again (backoff). */
  skipRemaining: number;
  lastNoteAt?: string;
  /** Highest item ordinal already analysed on this thread. */
  lastOrdinal: number;
}

/** A completed turn still to analyse. Kept until it succeeds or runs out of attempts. */
export interface PendingTurn {
  completedAt: string;
  attempts: number;
  /** Fixed per pending turn, so a retried delivery is a no-op on the T3 side. */
  clientRequestId: string;
  /** A note the model already produced, waiting for delivery. Retries skip the model call. */
  note?: Note;
  /** Highest item ordinal the note covers; committed to the thread once delivered. */
  maxOrdinal?: number;
}

export interface State {
  version: 1;
  /** completed_at watermark for the run poller (ISO string). Only drives discovery. */
  lastSeenRunAt?: string;
  /** Turns discovered but not yet analysed, by thread id. */
  pending: Record<string, PendingTurn>;
  threads: Record<string, ThreadState>;
  /** `inline` sink: notes waiting to be shown in their chat, by thread id. Read by the hook. */
  inbox: Record<string, InboxNote[]>;
}

export const MAX_RECENT = 10;

export function emptyState(): State {
  return { version: 1, pending: {}, threads: {}, inbox: {} };
}

export function emptyThread(): ThreadState {
  return { recent: [], consecutiveMisses: 0, skipRemaining: 0, lastOrdinal: 0 };
}

export class StateStore {
  state: State;
  private path: string;
  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): State {
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8"));
      if (s?.version === 1) return { ...emptyState(), ...s };
    } catch {
      // missing or corrupt file: start fresh
    }
    return emptyState();
  }

  thread(id: string): ThreadState {
    return (this.state.threads[id] ??= emptyThread());
  }

  addRecent(id: string, learn: string, at: string) {
    const t = this.thread(id);
    t.recent = [...t.recent, learn].slice(-MAX_RECENT);
    t.lastNoteAt = at;
    t.consecutiveMisses = 0;
    t.skipRemaining = 0;
  }


  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}

