import type { Config } from "../config.ts";
import type { Note } from "../parser.ts";
import type { StateStore } from "../state.ts";
import type { SourceDb as T3Sqlite } from "../sources.ts";
import { InlineSink } from "./inline.ts";
import { StdoutSink } from "./stdout.ts";

export interface DeliverResult {
  delivered: boolean;
}

export interface Sink {
  /** `clientRequestId` is stable across retries of the same note, so a retry does not queue it twice. */
  deliver(threadId: string, threadTitle: string, note: Note, clientRequestId: string): Promise<DeliverResult>;
}

/** `inline` needs the state store and the database; `stdout` does not. */
export function makeSink(cfg: Config, name = cfg.sink, ctx?: { store: StateStore; db: T3Sqlite }): Sink {
  if (name === "stdout") return new StdoutSink();
  if (!ctx) throw new Error("the inline sink needs the daemon state (use `run`, or --sink stdout)");
  return new InlineSink({ store: ctx.store, watermarks: (id) => ctx.db.watermarks(id) });
}
