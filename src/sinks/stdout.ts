import type { Note } from "../parser.ts";
import type { Sink } from "./index.ts";

export class StdoutSink implements Sink {
  async deliver(threadId: string, threadTitle: string, note: Note): Promise<boolean> {
    console.log(`[${threadTitle}] (${threadId})\n${note.tag} · ${note.learn}\n\n**${note.title}**\n${note.body}\n`);
    return true;
  }
}
