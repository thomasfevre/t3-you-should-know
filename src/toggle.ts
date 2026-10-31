// Per-chat off switch. On by default; `t3-ysk off` in a chat (the agent runs it) turns notes off there.
// Kept apart from the daemon state so the CLI never races the daemon's writes.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const disabledPath = (statePath: string) => join(dirname(statePath), "disabled-threads.json");

export function readDisabled(statePath: string): Set<string> {
  try {
    const v = JSON.parse(readFileSync(disabledPath(statePath), "utf8"));
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function setEnabled(statePath: string, threadId: string, enabled: boolean): void {
  const set = readDisabled(statePath);
  if (enabled) set.delete(threadId);
  else set.add(threadId);
  const p = disabledPath(statePath);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(`${p}.tmp`, JSON.stringify([...set], null, 2), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}
