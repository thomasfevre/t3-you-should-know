import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { makeBackend } from "./backends/index.ts";
import { loadConfig } from "./config.ts";
import { hookMain } from "./hook.ts";
import { enqueue } from "./queue.ts";
import { readDisabled, setEnabled } from "./toggle.ts";
import { analyze, Daemon } from "./daemon.ts";
import { makeSink } from "./sinks/index.ts";
import { StateStore } from "./state.ts";
import { readRuntime } from "./t3/runtime.ts";
import { T3Sqlite } from "./t3/sqlite.ts";

const USAGE = `t3-ysk run [--userdata <dir>]                  watch T3 and post notes (foreground)
t3-ysk once --thread <id> [--sink stdout|macos|t3] [--userdata <dir>]
                                            analyse one thread now; prints the note, or posts it with --sink t3
t3-ysk status [--userdata <dir>]               show state, T3 server and recent threads
t3-ysk queue --thread <id> [--learn <text>]    hand a note to the running daemon now (demos): the given line,
                                            or what the model finds in the thread right now
t3-ysk off|on [--thread <id>]                  turn notes off/on in a chat (default: the chat this runs in)
t3-ysk hook --provider claudeAgent|codex       UserPromptSubmit hook: hands queued notes to the agent (read-only)`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      thread: { type: "string" },
      sink: { type: "string" },
      userdata: { type: "string" },
      "no-state": { type: "boolean" },
      provider: { type: "string" },
      learn: { type: "string" },
    },
  });
  const cmd = positionals[0];
  const cfg = loadConfig();
  // --userdata points at another T3 home, e.g. a dev instance. Runtime file and sqlite both follow it.
  if (values.userdata) cfg.userdataDir = values.userdata;

  if (cmd === "off" || cmd === "on") {
    let id = values.thread ?? process.env.T3CODE_THREAD_ID;
    // In a T3 Codex chat there is no T3 thread env; Codex exposes its own session id instead.
    if (!id && process.env.CODEX_THREAD_ID) {
      const { HookSqlite } = await import("./hook.ts");
      id = new HookSqlite(cfg.userdataDir).threadForSession(process.env.CODEX_THREAD_ID, "codex") ?? undefined;
    }
    if (!id) throw new Error("no chat: run it from a T3 chat, or pass --thread <id>");
    setEnabled(cfg.statePath, id, cmd === "on");
    console.log(`You should know: ${cmd} for ${id}`);
    return;
  }
  if (cmd === "queue") {
    if (!values.thread) throw new Error("--thread <id> is required");
    let note;
    if (values.learn) note = { learn: values.learn, tag: "You should know" as const, title: values.learn, body: values.learn };
    else {
      const db = new T3Sqlite(cfg.userdataDir, true);
      const a = await analyze(db, makeBackend(cfg), cfg, new StateStore(cfg.statePath), values.thread);
      if (a.parsed.kind !== "note") {
        console.log(`model found nothing to say (${a.parsed.kind}); pass --learn "<text>" to queue your own line`);
        process.exit(2);
      }
      note = a.parsed.note;
    }
    enqueue(cfg.statePath, { threadId: values.thread, note });
    console.log(`queued for ${values.thread}:\n  ${note.learn}\nIt shows up at the top of the agent's next reply in that chat.`);
    return;
  }
  if (cmd === "hook") return hookMain(cfg, values.provider ?? "");
  if (cmd === "status") return status(cfg);
  if (cmd !== "run" && cmd !== "once") {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }

  const db = new T3Sqlite(cfg.userdataDir, cfg.includeSubagentThreads);
  const store = new StateStore(cfg.statePath);
  const backend = makeBackend(cfg);

  if (cmd === "once") {
    if (!values.thread) throw new Error("--thread <id> is required");
    const sink = makeSink(cfg, (values.sink as any) ?? "stdout");
    const thread = db.getThread(values.thread);
    if (!thread) throw new Error(`thread not found: ${values.thread}`);
    const a = await analyze(db, backend, cfg, store, values.thread);
    console.error(`transcript: ${a.transcript.length} chars, model call ${a.ms} ms`);
    if (a.parsed.kind === "note") {
      const r = await sink.deliver(values.thread, thread.title, a.parsed.note, randomUUID());
      console.error(r.delivered ? `delivered${r.notificationId ? ` (${r.notificationId})` : ""}` : "not delivered");
    } else console.log(a.parsed.kind === "none" ? "learn: none" : `invalid output (${a.parsed.reason}):\n${a.raw}`);
    // `once` never touches the state file; with --sink t3 it does post on the thread.
    return;
  }

  const sink = makeSink(cfg, cfg.sink, { store, db });
  const daemon = new Daemon(db, backend, sink, cfg, store);
  process.on("SIGINT", () => daemon.stop());
  process.on("SIGTERM", () => daemon.stop());
  await daemon.run();
}

function status(cfg: ReturnType<typeof loadConfig>) {
  const rt = readRuntime(cfg.userdataDir);
  console.log(`T3 server: ${rt ? `${rt.origin} (pid ${rt.pid})` : "not running"}`);
  console.log(`backend: ${cfg.backend} / ${cfg.model}, sink: ${cfg.sink}`);
  const store = new StateStore(cfg.statePath);
  console.log(`state: ${cfg.statePath}`);
  console.log(`watermark: ${store.state.lastSeenRunAt ?? "(never ran)"}, seen topics: ${store.state.seen.length}`);
  for (const [id, t] of Object.entries(store.state.threads)) {
    console.log(`  ${id}: misses=${t.consecutiveMisses} skip=${t.skipRemaining} open=${t.open.length} recent=${t.recent.length}`);
  }
  const off = readDisabled(cfg.statePath);
  if (off.size) console.log(`turned off in: ${[...off].join(", ")}`);
  for (const [id, notes] of Object.entries(store.state.inbox)) console.log(`  inbox ${id}: ${notes.map((n) => n.learn).join(" | ")}`);
  const db = new T3Sqlite(cfg.userdataDir, cfg.includeSubagentThreads);
  const problems = db.schemaProblems();
  console.log(problems.length ? `T3 FORMAT CHANGED: ${problems.join("; ")}` : "T3 format: ok");
  console.log("recent threads:");
  for (const t of db.recentThreads(5)) console.log(`  ${t.threadId}  ${t.title}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
