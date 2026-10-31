// Read-only access to T3's projection database. This module never writes.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { RawItem } from "../transcript.ts";
import { assistantTextsAfter, completedRunsAfter } from "../hook.ts";

export interface ThreadRow {
  threadId: string;
  title: string;
  updatedAt: string;
  archived: boolean;
}

export interface RunRow {
  runId: string;
  threadId: string;
  ordinal: number;
  status: string;
  completedAt: string;
}

export interface Resolution {
  /** `turn_item_id` of the notification row. */
  itemId: string;
  /** `id` field inside the payload, in case T3 uses a different id for the tool result. */
  payloadId?: string;
  threadId: string;
  summary: string;
  resolution: string;
}

const TERMINAL = ["completed", "failed", "interrupted", "cancelled"];

/** Child threads T3 creates for subagents and delegated tasks; the user never opens them directly. */
export const CHILD_THREAD_PREFIXES = ["thread:provider:", "thread:delegated-task:"];
export const isChildThread = (id: string): boolean => CHILD_THREAD_PREFIXES.some((p) => id.startsWith(p));

export class T3Sqlite {
  private db: DatabaseSync;

  private includeSubagents: boolean;

  constructor(userdataDir: string, includeSubagentThreads = false) {
    this.includeSubagents = includeSubagentThreads;
    // readOnly: the file is opened with SQLITE_OPEN_READONLY, WAL readers still see committed data.
    this.db = new DatabaseSync(join(userdataDir, "statev2.sqlite"), { readOnly: true });
    this.db.exec("PRAGMA busy_timeout = 2000");
  }

  /**
   * T3's tables are internal, not an API. Lists what this tool relies on and no longer finds,
   * so a T3 update that changes them shows up in the log instead of silently stopping notes.
   */
  schemaProblems(): string[] {
    const need: Record<string, string[]> = {
      orchestration_v2_projection_threads: ["thread_id", "title", "updated_at", "archived_at", "deleted_at"],
      orchestration_v2_projection_runs: ["thread_id", "ordinal", "status", "completed_at"],
      orchestration_v2_projection_turn_items: ["thread_id", "type", "status", "ordinal", "payload_json"],
      orchestration_v2_projection_provider_threads: ["thread_id", "payload_json"],
    };
    const out: string[] = [];
    for (const [table, cols] of Object.entries(need)) {
      const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((r) => r.name));
      if (have.size === 0) out.push(`table ${table} missing`);
      else for (const c of cols) if (!have.has(c)) out.push(`${table}.${c} missing`);
    }
    return out;
  }

  close() {
    this.db.close();
  }

  getThread(threadId: string): ThreadRow | null {
    const r = this.db
      .prepare(
        `SELECT thread_id, title, updated_at, archived_at, deleted_at
         FROM orchestration_v2_projection_threads WHERE thread_id = ?`,
      )
      .get(threadId) as any;
    if (!r || r.deleted_at) return null;
    return { threadId: r.thread_id, title: r.title, updatedAt: r.updated_at, archived: !!r.archived_at };
  }

  recentThreads(limit = 10): ThreadRow[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id, title, updated_at FROM orchestration_v2_projection_threads
         WHERE archived_at IS NULL AND deleted_at IS NULL
         ORDER BY updated_at DESC`,
      )
      .all() as any[];
    return rows
      .filter((r) => this.includeSubagents || !isChildThread(r.thread_id))
      .slice(0, limit)
      .map((r) => ({ threadId: r.thread_id, title: r.title, updatedAt: r.updated_at, archived: false }));
  }

  /** Root runs that reached a terminal status after `sinceIso`, oldest first. */
  terminalRunsSince(sinceIso: string): RunRow[] {
    const marks = TERMINAL.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT run_id, thread_id, ordinal, status, completed_at
         FROM orchestration_v2_projection_runs
         WHERE completed_at IS NOT NULL AND completed_at > ? AND status IN (${marks})
         ORDER BY completed_at ASC`,
      )
      .all(sinceIso, ...TERMINAL) as any[];
    return rows
      .filter((r) => this.includeSubagents || !isChildThread(r.thread_id))
      .map((r) => ({
        runId: r.run_id,
        threadId: r.thread_id,
        ordinal: r.ordinal,
        status: r.status,
        completedAt: r.completed_at,
      }));
  }

  /** Items of a thread, oldest first. `ordinal` is global to the thread (run ordinal * 1e6 + n). */
  items(threadId: string, afterOrdinal = 0): RawItem[] {
    const rows = this.db
      .prepare(
        `SELECT type, status, ordinal, payload_json FROM orchestration_v2_projection_turn_items
         WHERE thread_id = ? AND ordinal > ? ORDER BY ordinal ASC`,
      )
      .all(threadId, afterOrdinal) as any[];
    return rows.map((r) => ({
      type: r.type,
      status: r.status,
      ordinal: r.ordinal,
      payload: JSON.parse(r.payload_json),
    }));
  }

  /** Watermarks for a note queued now: highest root run ordinal and highest turn-item ordinal. */
  watermarks(threadId: string): { run: number; item: number } {
    const run = this.db.prepare(`SELECT MAX(ordinal) AS m FROM orchestration_v2_projection_runs WHERE thread_id = ?`).get(threadId) as any;
    const item = this.db
      .prepare(`SELECT MAX(ordinal) AS m FROM orchestration_v2_projection_turn_items WHERE thread_id = ?`)
      .get(threadId) as any;
    return { run: Number(run?.m ?? 0), item: Number(item?.m ?? 0) };
  }

  assistantTextsAfter(threadId: string, itemOrdinal: number): string[] {
    return assistantTextsAfter(this.db, threadId, itemOrdinal);
  }

  completedRunsAfter(threadId: string, runOrdinal: number): number {
    return completedRunsAfter(this.db, threadId, runOrdinal);
  }

  /**
   * External notifications that carry a resolution. These only exist once the T3 patch
   * (notification.source.kind = "external", `resolution` field) has landed; before that this is empty.
   */
  resolutions(threadId: string): Resolution[] {
    const rows = this.db
      .prepare(
        `SELECT turn_item_id, thread_id, payload_json FROM orchestration_v2_projection_turn_items
         WHERE thread_id = ? AND type = 'notification'`,
      )
      .all(threadId) as any[];
    const out: Resolution[] = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload_json);
      if (p?.source?.kind === "external" && p.resolution) {
        out.push({ itemId: r.turn_item_id, payloadId: p.id, threadId: r.thread_id, summary: p.summary, resolution: p.resolution });
      }
    }
    return out;
  }
}
