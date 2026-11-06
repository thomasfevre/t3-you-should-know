// BB is an input only. Never open its database for writing.
import { DatabaseSync } from "node:sqlite";
import type { HookProvider } from "../hook.ts";
import type { RawItem } from "../transcript.ts";
export const bbKey = (id: string) => `bb:${id}`;
const raw = (id: string) => id.replace(/^bb:/, "");
export class BbSqlite {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec("PRAGMA busy_timeout = 100");
  }
  close() { this.db.close(); }
  schemaProblems(): string[] {
    return ["threads", "events"].filter(t => !this.db.prepare(`PRAGMA table_info(${t})`).all().length).map(t => `BB table ${t} missing`);
  }
  getThread(id: string) {
    const r = this.db.prepare("SELECT * FROM threads WHERE id=? AND deleted_at IS NULL").get(raw(id)) as any;
    return r ? { threadId: bbKey(r.id), title: r.title ?? r.title_fallback ?? "", updatedAt: new Date(r.updated_at).toISOString(), archived: r.archived_at != null } : null;
  }
  recentThreads(limit = 10) {
    return (this.db.prepare("SELECT id FROM threads WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?").all(limit) as any[]).map(r => this.getThread(r.id)!);
  }
  terminalRunsSince(since: string) {
    return (this.db.prepare("SELECT * FROM events WHERE type='turn/completed' AND created_at>? ORDER BY created_at,sequence").all(Date.parse(since)) as any[]).map(r => ({runId:r.turn_id, threadId:bbKey(r.thread_id), ordinal:r.sequence, status:JSON.parse(r.data).status, completedAt:new Date(r.created_at).toISOString()}));
  }
  items(id: string, after = 0): RawItem[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE thread_id=? AND sequence>? AND type IN ('item/completed','client/turn/requested') ORDER BY sequence").all(raw(id),after) as any[];
    return rows.flatMap(r => {
      const d = JSON.parse(r.data);
      if (r.type === 'client/turn/requested') {
        const text = (Array.isArray(d.input) ? d.input : []).filter((i: any) => i.type === 'text' && typeof i.text === 'string').map((i: any) => i.text).join('\n');
        return text ? [{type:'user_message', ordinal:r.sequence, payload:{text}}] : [];
      }
      const i = d.item ?? {};
      const types: Record<string,string> = {agentMessage:'assistant_message', userMessage:'user_message',commandExecution:'command_execution',toolCall:'dynamic_tool',fileChange:'file_change'};
      if (!types[i.type]) return [];
      return [{type:types[i.type], status:i.status ?? 'completed', ordinal:r.sequence, payload:{text:i.text,input:i.command ?? i.arguments,exitCode:i.exitCode,toolName:i.tool,fileName:i.path}}];
    });
  }
  watermarks(id: string) {
    const r = this.db.prepare("SELECT MAX(sequence) AS item, MAX(CASE WHEN type='turn/completed' THEN sequence ELSE 0 END) AS run FROM events WHERE thread_id=?").get(raw(id)) as any;
    return {item:Number(r.item ?? 0),run:Number(r.run ?? 0)};
  }
  assistantTextsAfter(id: string, after: number) { return this.items(id,after).filter(i=>i.type==='assistant_message').map(i=>String(i.payload.text ?? '')); }
  completedRunsAfter(id: string, after: number) {
    return Number((this.db.prepare("SELECT COUNT(DISTINCT turn_id) AS n FROM events WHERE thread_id=? AND sequence>? AND type='turn/completed' AND json_extract(data,'$.status')='completed'").get(raw(id),after) as any).n);
  }
  threadForSession(session: string, provider: HookProvider): string | null {
    const rows = this.db.prepare("SELECT DISTINCT e.thread_id FROM events e JOIN threads t ON t.id=e.thread_id WHERE e.type='thread/identity' AND e.provider_thread_id=? AND t.provider_id=? AND t.deleted_at IS NULL").all(session,provider==='claudeAgent'?'claude-code':'codex') as any[];
    return rows.length===1 ? bbKey(rows[0].thread_id) : null;
  }
  bindingMatches(id: string, session: string, provider: HookProvider) { return this.threadForSession(session,provider) === bbKey(raw(id)); }
}
