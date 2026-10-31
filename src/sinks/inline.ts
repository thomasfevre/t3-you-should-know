import { randomUUID } from "node:crypto";
import { MAX_INBOX_PER_THREAD } from "../inline.ts";
import type { Note } from "../parser.ts";
import type { StateStore } from "../state.ts";
import type { DeliverResult, Sink } from "./index.ts";

export interface InlineSinkDeps {
  store: StateStore;
  watermarks(threadId: string): { run: number; item: number };
  markUnread(threadId: string): Promise<boolean>;
  log?: (msg: string) => void;
}

/** Queues the note for the UserPromptSubmit hook and puts T3's unread dot on the chat. */
export class InlineSink implements Sink {
  private deps: InlineSinkDeps;
  constructor(deps: InlineSinkDeps) {
    this.deps = deps;
  }

  async deliver(threadId: string, _title: string, note: Note, clientRequestId: string): Promise<DeliverResult> {
    const { store } = this.deps;
    const inbox = (store.state.inbox[threadId] ??= []);
    // A retried delivery of the same note must not queue it twice.
    if (!inbox.some((n) => n.noteId === clientRequestId)) {
      const w = this.deps.watermarks(threadId);
      inbox.push({
        noteId: clientRequestId || randomUUID(),
        learn: note.learn,
        createdAt: new Date().toISOString(),
        runWatermark: w.run,
        itemWatermark: w.item,
      });
      store.state.inbox[threadId] = inbox.slice(-MAX_INBOX_PER_THREAD);
    }
    // The inbox is what counts; the dot is only a hint.
    if (!(await this.deps.markUnread(threadId))) this.deps.log?.(`${threadId}: mark_unread failed (note still queued)`);
    return { delivered: true };
  }
}
