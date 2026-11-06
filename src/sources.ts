import { existsSync } from "node:fs";
import { T3Sqlite } from "./t3/sqlite.ts";
import { BbSqlite } from "./bb/sqlite.ts";
import type { Config } from "./config.ts";
export type SourceDb = Pick<T3Sqlite, "items"|"getThread"|"recentThreads"|"terminalRunsSince"|"schemaProblems"|"watermarks"|"assistantTextsAfter"|"completedRunsAfter">;
export class Sources implements SourceDb {
  private sources: {t3?: SourceDb; bb?: SourceDb} = {};
  constructor(cfg: Config) {
    if (cfg.sources.includes('t3') && existsSync(`${cfg.userdataDir}/statev2.sqlite`)) this.sources.t3 = new T3Sqlite(cfg.userdataDir,cfg.includeSubagentThreads);
    if (cfg.sources.includes('bb') && existsSync(cfg.bbDbPath)) this.sources.bb = new BbSqlite(cfg.bbDbPath);
  }
  private source(id: string) { const db=this.sources[id.startsWith('bb:')?'bb':'t3']; if(!db) throw new Error('source unavailable'); return db; }
  items(id: string, after=0) { return this.source(id).items(id,after); }
  getThread(id: string) { return this.source(id).getThread(id); }
  watermarks(id: string) { return this.source(id).watermarks(id); }
  assistantTextsAfter(id:string,after:number) { return this.source(id).assistantTextsAfter(id,after); }
  completedRunsAfter(id:string,after:number) { return this.source(id).completedRunsAfter(id,after); }
  recentThreads(limit=10) { return Object.values(this.sources).flatMap(s=>s.recentThreads(limit)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,limit); }
  terminalRunsSince(since:string) { return Object.values(this.sources).flatMap(s=>s.terminalRunsSince(since)).sort((a,b)=>a.completedAt.localeCompare(b.completedAt)); }
  schemaProblems() { return Object.values(this.sources).flatMap(s=>s.schemaProblems()); }
}
