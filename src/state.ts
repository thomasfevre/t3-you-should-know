import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ThreadState {
  /** Last "learn:" lines offered on this thread, newest last, max 10. */
  recent: string[];
  consecutiveMisses: number;
  /** Turns still to skip before asking again (backoff). */
  skipRemaining: number;
  lastNoteAt?: string;
  /** Learn lines posted and not yet resolved by the user. */
  open: string[];
  /** Highest item ordinal already analysed on this thread. */
  lastOrdinal: number;
}

export interface State {
  version: 1;
  /** completed_at watermark for the run poller (ISO string). */
  lastSeenRunAt?: string;
  threads: Record<string, ThreadState>;
  /** Learn lines the user marked "Got it", global across threads. */
  seen: string[];
}

export const MAX_RECENT = 10;
export const MAX_SEEN = 50;

export function emptyState(): State {
  return { version: 1, threads: {}, seen: [] };
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

  addRecent(id: string, learn: string, at: string) {
    const t = this.thread(id);
    t.recent = [...t.recent, learn].slice(-MAX_RECENT);
    t.open = [...t.open, learn];
    t.lastNoteAt = at;
    t.consecutiveMisses = 0;
    t.skipRemaining = 0;
  }

  /** `acknowledged` feeds the avoid lists; other resolutions only close the note. */
  resolve(id: string, learn: string, resolution: "acknowledged" | "dismissed" | "asked") {
    const t = this.thread(id);
    t.open = t.open.filter((l) => l !== learn);
    if (resolution === "acknowledged" && !this.state.seen.includes(learn)) {
      this.state.seen = [...this.state.seen, learn].slice(-MAX_SEEN);
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}
