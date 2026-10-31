// `t3-ysk hook --provider claudeAgent|codex`: UserPromptSubmit hook for Claude Code and Codex.
// Read-only on both T3's database and the daemon state. Any doubt -> prints nothing, exits 0.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { readDisabled } from "./toggle.ts";
import { alreadyShown, hookContext, type InboxNote, type InlineDb } from "./inline.ts";

export type HookProvider = "claudeAgent" | "codex";

export interface HookDb extends InlineDb {
  /** True when T3 binds this native session of this provider to this app thread. */
  bindingMatches(threadId: string, nativeSessionId: string, provider: HookProvider): boolean;
}

export interface HookInput {
  env: Record<string, string | undefined>;
  stdin: string;
  provider: HookProvider;
  db: HookDb;
  /** Daemon state file contents (JSON text). */
  state: string;
  cfg: Pick<Config, "onlyThreads">;
  /** Threads the user turned notes off in. */
  disabled?: Set<string>;
  /** Shell command that turns notes off in this chat, shown to the agent. */
  offCommand?: string;
}

/** Returns the hook's stdout, or null to print nothing. Never throws. */
export function runHook(input: HookInput): string | null {
  try {
    // Only a provider process T3 spawned carries this. A terminal resume of the same session does not.
    const threadId = input.env.T3CODE_THREAD_ID;
    if (!threadId) return null;
    if (input.cfg.onlyThreads && !input.cfg.onlyThreads.includes(threadId)) return null;
    if (input.disabled?.has(threadId)) return null;
    const sessionId = JSON.parse(input.stdin)?.session_id;
    if (typeof sessionId !== "string" || !sessionId) return null;
    if (!input.db.bindingMatches(threadId, sessionId, input.provider)) return null;

    const inbox: InboxNote[] = JSON.parse(input.state)?.inbox?.[threadId] ?? [];
    // The daemon may not have reconciled yet: never re-inject a note already in the thread.
    const notes = inbox.filter((n) => !alreadyShown(input.db, threadId, n));
    if (notes.length === 0) return null;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: hookContext(notes, input.offCommand) },
    });
  } catch {
    return null;
  }
}

/** Small read-only view of statev2.sqlite for the hook, with a short lock wait. */
export class HookSqlite implements HookDb {
  private db: DatabaseSync;
  constructor(userdataDir: string) {
    this.db = new DatabaseSync(join(userdataDir, "statev2.sqlite"), { readOnly: true });
    this.db.exec("PRAGMA busy_timeout = 100");
  }

  bindingMatches(threadId: string, nativeSessionId: string, provider: HookProvider): boolean {
    const r = this.db
      .prepare(
        `SELECT 1 FROM orchestration_v2_projection_provider_threads
         WHERE thread_id = ? AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ?
           AND COALESCE(driver, json_extract(payload_json, '$.driver')) = ? LIMIT 1`,
      )
      .get(threadId, nativeSessionId, provider);
    return !!r;
  }

  assistantTextsAfter(threadId: string, itemOrdinal: number): string[] {
    return assistantTextsAfter(this.db, threadId, itemOrdinal);
  }

  completedRunsAfter(threadId: string, runOrdinal: number): number {
    return completedRunsAfter(this.db, threadId, runOrdinal);
  }
}

export function assistantTextsAfter(db: DatabaseSync, threadId: string, itemOrdinal: number): string[] {
  const rows = db
    .prepare(
      `SELECT payload_json FROM orchestration_v2_projection_turn_items
       WHERE thread_id = ? AND type = 'assistant_message' AND ordinal > ? ORDER BY ordinal ASC`,
    )
    .all(threadId, itemOrdinal) as any[];
  return rows.map((r) => String(JSON.parse(r.payload_json)?.text ?? ""));
}

export function completedRunsAfter(db: DatabaseSync, threadId: string, runOrdinal: number): number {
  const r = db
    .prepare(
      `SELECT COUNT(DISTINCT ordinal) AS n FROM orchestration_v2_projection_runs
       WHERE thread_id = ? AND ordinal > ? AND status = 'completed'`,
    )
    .get(threadId, runOrdinal) as any;
  return Number(r?.n ?? 0);
}

export function hookMain(cfg: Config, provider: string): void {
  if (provider !== "claudeAgent" && provider !== "codex") return;
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    return;
  }
  let state = "";
  try {
    state = readFileSync(cfg.statePath, "utf8");
  } catch {
    return; // daemon never ran: nothing to show
  }
  let db: HookSqlite;
  try {
    db = new HookSqlite(cfg.userdataDir);
  } catch {
    return;
  }
  const offCommand = `${process.execPath} ${process.argv[1]} off`;
  const out = runHook({ env: process.env, stdin, provider, db, state, cfg, disabled: readDisabled(cfg.statePath), offCommand });
  if (out) process.stdout.write(out);
}
