import type { Config } from "../config.ts";
import type { Note } from "../parser.ts";
import { readRuntime } from "../t3/runtime.ts";
import { MacosSink } from "./macos.ts";
import { StdoutSink } from "./stdout.ts";
import { T3Sink } from "./t3.ts";

export interface Sink {
  /** Returns true when the note was delivered somewhere. */
  deliver(threadId: string, threadTitle: string, note: Note): Promise<boolean>;
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
