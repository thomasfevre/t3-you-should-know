import { parseArgs } from "node:util";
import { makeBackend } from "./backends/index.ts";
import { loadConfig } from "./config.ts";
import { analyze, Daemon } from "./daemon.ts";
import { makeSink } from "./sinks/index.ts";
import { StateStore } from "./state.ts";
import { readRuntime } from "./t3/runtime.ts";
import { T3Sqlite } from "./t3/sqlite.ts";

const USAGE = `t3-ysk run                                  watch T3 and post notes (foreground)
t3-ysk once --thread <id> [--sink stdout|macos|t3] [--no-state]
                                            analyse one thread now and print the model output
t3-ysk status                               show state, T3 server and recent threads`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      thread: { type: "string" },
      sink: { type: "string" },
      "no-state": { type: "boolean" },
    },
  });
  const cmd = positionals[0];
  const cfg = loadConfig();

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
    if (a.parsed.kind === "note") await sink.deliver(values.thread, thread.title, a.parsed.note);
    else console.log(a.parsed.kind === "none" ? "learn: none" : `invalid output (${a.parsed.reason}):\n${a.raw}`);
    // `once` is a dry run: it never touches the state file.
    return;
  }

  const sink = makeSink(cfg);
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
  const db = new T3Sqlite(cfg.userdataDir, cfg.includeSubagentThreads);
  console.log("recent threads:");
  for (const t of db.recentThreads(5)) console.log(`  ${t.threadId}  ${t.title}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
