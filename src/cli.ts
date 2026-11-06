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
import { Sources } from "./sources.ts";

const USAGE = `t3-ysk run [--userdata <dir>]                  watch T3 and queue notes (foreground)
t3-ysk once --thread <id> [--sink stdout] [--userdata <dir>]
                                            analyse one thread now and print the note
t3-ysk status [--userdata <dir>]               show state, pending notes and recent threads
t3-ysk queue --thread <id|latest> [--learn <text>]    hand a note to the running daemon now (demos): the given line,
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
    let id = values.thread ?? (process.env.BB_THREAD_ID ? `bb:${process.env.BB_THREAD_ID}` : process.env.T3CODE_THREAD_ID);
    // In a T3 Codex chat there is no T3 thread env; Codex exposes its own session id instead.
    if (!id && process.env.CODEX_THREAD_ID) {
      const { HookSqlite } = await import("./hook.ts");
      const { BbSqlite } = await import("./bb/sqlite.ts");
      id = (process.env.BB_CLI ? new BbSqlite(cfg.bbDbPath) : new HookSqlite(cfg.userdataDir)).threadForSession(process.env.CODEX_THREAD_ID, "codex") ?? undefined;
    }
    if (!id) throw new Error("no chat: run it from a T3 chat, or pass --thread <id>");
    setEnabled(cfg.statePath, id, cmd === "on");
    console.log(`You should know: ${cmd} for ${id}`);
    return;
  }
  if (cmd === "queue") {
    if (!values.thread) throw new Error("--thread <id|latest> is required");
    // "latest": the chat that moved last, i.e. the one you are recording in.
    if (values.thread === "latest") values.thread = new Sources(cfg).recentThreads(1)[0]?.threadId;
    if (!values.thread) throw new Error("no recent chat found");
    let note;
    if (values.learn) note = { learn: values.learn, tag: "You should know" as const, title: values.learn, body: values.learn };
    else {
      const db = new Sources(cfg);
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

  const db = new Sources(cfg);
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
      console.error(r.delivered ? "delivered" : "not delivered");
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
  console.log(`backend: ${cfg.backend} / ${cfg.model}, sink: ${cfg.sink}`);
  const store = new StateStore(cfg.statePath);
  console.log(`state: ${cfg.statePath}`);
  console.log(`watermark: ${store.state.lastSeenRunAt ?? "(never ran)"}`);
  for (const [id, t] of Object.entries(store.state.threads)) {
    console.log(`  ${id}: misses=${t.consecutiveMisses} skip=${t.skipRemaining} recent=${t.recent.length}`);
  }
  const off = readDisabled(cfg.statePath);
  if (off.size) console.log(`turned off in: ${[...off].join(", ")}`);
  for (const [id, notes] of Object.entries(store.state.inbox)) console.log(`  inbox ${id}: ${notes.map((n) => n.learn).join(" | ")}`);
  const db = new Sources(cfg);
  const problems = db.schemaProblems();
  console.log(problems.length ? `SOURCE FORMAT CHANGED: ${problems.join("; ")}` : "source formats: ok");
  console.log("recent threads:");
  for (const t of db.recentThreads(5)) console.log(`  ${t.threadId}  ${t.title}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
