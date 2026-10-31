import type { Config } from "../config.ts";
import type { Note } from "../parser.ts";
import type { StateStore } from "../state.ts";
import { T3Mcp } from "../t3/mcp.ts";
import type { T3Sqlite } from "../t3/sqlite.ts";
import { InlineSink } from "./inline.ts";
import { readRuntime } from "../t3/runtime.ts";
import { MacosSink } from "./macos.ts";
import { StdoutSink } from "./stdout.ts";
import { T3Sink } from "./t3.ts";

export interface DeliverResult {
  delivered: boolean;
  /** Id returned by T3 (`t3_thread_notify`), used to match the resolution later. */
  notificationId?: string;
}

export interface Sink {
  /** `clientRequestId` is stable across retries of the same note, for idempotent delivery. */
  deliver(threadId: string, threadTitle: string, note: Note, clientRequestId: string): Promise<DeliverResult>;
}

/** `inline` needs the state store and the database; the other sinks do not. */
export function makeSink(cfg: Config, name = cfg.sink, ctx?: { store: StateStore; db: T3Sqlite }): Sink {
  switch (name) {
    case "inline": {
      if (!ctx) throw new Error("the inline sink needs the daemon state (use `run`, or --sink stdout)");
      const rt = readRuntime(cfg.userdataDir);
      const mcp = new T3Mcp(rt?.origin ?? "http://127.0.0.1:3773", cfg.t3Token);
      return new InlineSink({
        store: ctx.store,
        watermarks: (id) => ctx.db.watermarks(id),
        markUnread: (id) => mcp.markUnread(id),
        log: (m) => console.log(`${new Date().toISOString()} ${m}`),
      });
    }
    case "stdout":
      return new StdoutSink();
    case "macos":
      return new MacosSink();
    case "t3": {
      const rt = readRuntime(cfg.userdataDir);
      return new T3Sink(rt?.origin ?? "http://127.0.0.1:3773", cfg.t3Token);
    }
  }
}
