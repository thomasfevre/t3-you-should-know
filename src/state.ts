import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Note } from "./parser.ts";

export interface OpenNote {
  learn: string;
  /** Id returned by `t3_thread_notify`, when known. Preferred for matching. */
  notificationId?: string;
}

export interface ThreadState {
  /** Last "learn:" lines offered on this thread, newest last, max 10. */
  recent: string[];
  consecutiveMisses: number;
  /** Turns still to skip before asking again (backoff). */
  skipRemaining: number;
  lastNoteAt?: string;
  /** Notes posted and not yet resolved by the user. */
  open: OpenNote[];
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
  /** Learn lines the user marked "Got it", global across threads. */
  seen: string[];
}

export const MAX_RECENT = 10;
export const MAX_SEEN = 50;

export function emptyState(): State {
  return { version: 1, pending: {}, threads: {}, seen: [] };
}

export function emptyThread(): ThreadState {
  return { recent: [], consecutiveMisses: 0, skipRemaining: 0, open: [], lastOrdinal: 0 };
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

  addRecent(id: string, learn: string, at: string, notificationId?: string) {
    const t = this.thread(id);
    t.recent = [...t.recent, learn].slice(-MAX_RECENT);
    t.open = [...t.open, { learn, notificationId }];
    t.lastNoteAt = at;
    t.consecutiveMisses = 0;
    t.skipRemaining = 0;
  }

  /** `acknowledged` feeds the avoid lists; other resolutions only close the note. */
  resolve(id: string, note: OpenNote, resolution: "acknowledged" | "dismissed" | "asked") {
    const t = this.thread(id);
    t.open = t.open.filter((n) => n !== note);
    if (resolution === "acknowledged" && !this.state.seen.includes(note.learn)) {
      this.state.seen = [...this.state.seen, note.learn].slice(-MAX_SEEN);
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}

/**
 * Find the open note a resolution row refers to. The notification id wins; the learn text is only
 * a fallback for notes posted without an id (or when T3 returned an id we cannot see in the rows).
 */
export function matchOpenNote(
  open: OpenNote[],
  row: { itemId: string; payloadId?: string; summary: string },
): OpenNote | undefined {
  const byId = open.find((n) => n.notificationId && (n.notificationId === row.itemId || n.notificationId === row.payloadId));
  if (byId) return byId;
  return open.find((n) => !n.notificationId && n.learn === row.summary);
}
