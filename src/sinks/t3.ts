import { randomUUID } from "node:crypto";
import type { Note } from "../parser.ts";
import { T3Mcp } from "../t3/mcp.ts";
import type { DeliverResult, Sink } from "./index.ts";

export const AGENT_NAME = "You should know";

/** Posts the note on the thread with the `t3_thread_notify` MCP tool (needs the T3 patch). */
export class T3Sink implements Sink {
  private mcp: T3Mcp;
  private warned = new Set<string>();

  constructor(origin: string, token?: string) {
    this.mcp = new T3Mcp(origin, token);
  }

  async deliver(threadId: string, _title: string, note: Note): Promise<DeliverResult> {
    const res = await this.mcp.notify({
      threadId,
      summary: note.learn,
      title: note.title,
      body: note.body,
      tag: note.tag,
      agent: AGENT_NAME,
      clientRequestId: randomUUID(),
    });
    if (res.ok) return { delivered: true, notificationId: res.notificationId };
    // Log each failure kind once so a missing tool does not flood the log.
    if (!this.warned.has(res.reason)) {
      this.warned.add(res.reason);
      console.error(`[t3 sink] not delivered (${res.reason}): ${res.detail}`);
    }
    return { delivered: false };
  }
}
