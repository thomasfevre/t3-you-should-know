import type { Note } from "../parser.ts";
import type { DeliverResult, Sink } from "./index.ts";

export class StdoutSink implements Sink {
  async deliver(threadId: string, threadTitle: string, note: Note): Promise<DeliverResult> {
    console.log(`[${threadTitle}] (${threadId})\n${note.tag} · ${note.learn}\n\n**${note.title}**\n${note.body}\n`);
    return { delivered: true };
  }
}
