import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BbSqlite } from '../src/bb/sqlite.ts';
import { resolveThread, runHook } from '../src/hook.ts';
import { buildTranscript } from '../src/transcript.ts';

describe('BB fixture database', () => {
  it('reads turns, normalized items, bindings and watermarks without changing the DB', () => {
    const dir=mkdtempSync(join(tmpdir(),'ysk-bb-')); const path=join(dir,'bb.db');
    const writer=new DatabaseSync(path);
    writer.exec(`CREATE TABLE threads(id TEXT, provider_id TEXT, title TEXT, title_fallback TEXT, updated_at INTEGER, archived_at INTEGER, deleted_at INTEGER);
      CREATE TABLE events(thread_id TEXT, provider_thread_id TEXT, turn_id TEXT, sequence INTEGER, type TEXT, data TEXT, created_at INTEGER);
      INSERT INTO threads VALUES ('same','claude-code','Fixture',NULL,1000,NULL,NULL);
      INSERT INTO threads VALUES ('codex','codex','Codex',NULL,1000,NULL,NULL);`);
    const put=writer.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)');
    put.run('same','native','turn',1,'thread/identity','{}',1000);
    put.run('same','native','turn',2,'client/turn/requested',JSON.stringify({input:[{type:'text',text:'Run tests'}]}),1001);
    put.run('same','native','turn',3,'item/completed',JSON.stringify({item:{type:'agentMessage',text:'Tests passed'}}),1002);
    put.run('same','native','turn',4,'turn/completed','{"status":"completed"}',1003);
    put.run('codex','cx','turn',1,'thread/identity','{}',1000);
    writer.close(); const before=readFileSync(path);
    const db=new BbSqlite(path);
    try {
      expect(db.schemaProblems()).toEqual([]);
      expect(db.getThread('bb:same')?.title).toBe('Fixture');
      expect(db.recentThreads()).toHaveLength(2);
      expect(db.terminalRunsSince(new Date(0).toISOString())[0]).toMatchObject({threadId:'bb:same',ordinal:4,status:'completed'});
      expect(buildTranscript(db.items('bb:same'))).toBe('USER: Run tests\nASSISTANT: Tests passed');
      expect(db.watermarks('bb:same')).toEqual({run:4,item:4});
      expect(db.assistantTextsAfter('bb:same',2)).toEqual(['Tests passed']);
      expect(db.completedRunsAfter('bb:same',0)).toBe(1);
      expect(resolveThread({BB_THREAD_ID:'same'},'native','claudeAgent',db)).toBe('bb:same');
      expect(resolveThread({BB_THREAD_ID:'wrong'},'native','claudeAgent',db)).toBeNull();
      expect(resolveThread({BB_THREAD_ID:'same'},'native','codex',db)).toBeNull();
      expect(resolveThread({},'native','claudeAgent',db)).toBeNull();
      expect(resolveThread({BB_CLI:'/bb'},'cx','codex',db)).toBe('bb:codex');
      expect(runHook({env:{BB_THREAD_ID:'same'},stdin:'bad',provider:'claudeAgent',db,state:'{}',cfg:{}})).toBeNull();
      const args = {env:{BB_THREAD_ID:'same'},stdin:'{"session_id":"native"}',provider:'claudeAgent' as const,db,state:JSON.stringify({inbox:{'bb:same':[{noteId:'n',learn:'Check this test',createdAt:new Date().toISOString(),runWatermark:4,itemWatermark:4}]}}),cfg:{}};
      expect(runHook(args)).toContain('Check this test');
      expect(runHook({...args,disabled:new Set(['bb:same'])})).toBeNull();
      expect(runHook({...args,cfg:{onlyThreads:['same']}})).toBeNull();
      expect(readFileSync(path)).toEqual(before);
    } finally { db.close(); rmSync(dir,{recursive:true}); }
  });
  it('rejects a native session shared by two BB threads', () => {
    const dir=mkdtempSync(join(tmpdir(),'ysk-bb-')); const path=join(dir,'bb.db'); const w=new DatabaseSync(path);
    w.exec(`CREATE TABLE threads(id TEXT,provider_id TEXT,deleted_at INTEGER); CREATE TABLE events(thread_id TEXT,provider_thread_id TEXT,type TEXT);
      INSERT INTO threads VALUES ('a','codex',NULL),('b','codex',NULL);
      INSERT INTO events VALUES ('a','shared','thread/identity'),('b','shared','thread/identity');`); w.close();
    const db=new BbSqlite(path);
    try { expect(resolveThread({BB_CLI:'/bb'},'shared','codex',db)).toBeNull(); }
    finally {db.close();rmSync(dir,{recursive:true});}
  });
});
