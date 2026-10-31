// `t3-ysk queue`: hand a note to the running daemon now (demos, manual tests).
// The CLI only appends to queued.json; the daemon is still the only writer of the state file.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Note } from "./parser.ts";

export interface QueuedNote {
  threadId: string;
  note: Note;
}

export const queuePath = (statePath: string) => join(dirname(statePath), "queued.json");

export function enqueue(statePath: string, item: QueuedNote): void {
  const p = queuePath(statePath);
  let items: QueuedNote[] = [];
  try {
    items = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // no queue yet
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify([...items, item], null, 2));
  renameSync(`${p}.tmp`, p);
}

/** Daemon side: take everything queued so far. The rename makes a concurrent enqueue start a new file. */
export function takeQueued(statePath: string): QueuedNote[] {
  const p = queuePath(statePath);
  if (!existsSync(p)) return [];
  const taken = `${p}.taken`;
  try {
    renameSync(p, taken);
    const items = JSON.parse(readFileSync(taken, "utf8"));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  } finally {
    rmSync(taken, { force: true });
  }
}
