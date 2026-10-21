import type { Config } from "../config.ts";
import type { Note } from "../parser.ts";
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
  deliver(threadId: string, threadTitle: string, note: Note): Promise<DeliverResult>;
}

export function makeSink(cfg: Config, name = cfg.sink): Sink {
  switch (name) {
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
