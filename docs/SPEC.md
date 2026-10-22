# "You should know" for T3 Code — shared spec (advisor-owned, read-only for executors)

## What we are replicating (Claude Code builtin plugin `cc-plugin-you-should-know`, reverse-engineered from the 2.1.306 binary)

Mechanism:
1. After a turn of the main agent completes, a *side agent* (separate cheap model call, no tools) gets the conversation so far plus two lists:
   - "These are the last suggestions offered to the user. You should skip them:" (recent `learn:` lines, or "(nothing yet)")
   - "The person said they already understood these topics, so make sure to avoid offering them:" (topics the user answered *Got it / Know this already*)
2. It outputs EITHER `learn: none` OR:
   ```
   learn: <1-2 sentences, ~20 words, ends with a period>
   tag: <You should know | Heads up>
   **<short readable title, bold, own line>**
   <plain-language explainer, markdown, digestible at a glance>
   ```
   Rules in the prompt (quote them verbatim in the daemon prompt):
   - Role: "You are a helpful observer whose goal is to help the human better understand their work. Pause for a moment to reflect on this session so far. Is there anything that the human should *really* know about their session, that they very likely (or clearly) do not understand? Try to find one topic to suggest to the human to understand, and explain it in plain language."
   - "Your job is to produce suggestions and explanations only when helpful, only when there are consequences if it is not understood. Think of your role as a wise, knowledge guide for the human who empowers them to find agency, satisfaction, and success in their work."
   - **Context matters!** The topic should have great significance to their work, and have a potential negative implication if they do not understand over time.
   - **Avoid topics that the human is already discussing.** If they asked the agent to explain X, don't suggest X. Skip the topic if the person plausibly engaged with and understood it in the main session. A decision or a technical detail the agent mentioned in passing, inside a long answer or in the middle of a long task or tool call sequence, is acceptable if consequential, because people don't read everything the agent writes.
   - **Default to learn: none.** The bar is very high. When in doubt, suggest nothing.
   - tag **You should know**: default; the user should understand how something works (a system, a concept, a design), and it deeply matters for their work. tag **Heads up**: about the work in this session: a decision the agent made, something it did not highlight, or a result that may be off, and there is an immediate cost if they miss it. If neither reads naturally in front of the line, the topic does not clear the bar: `learn: none`.
   - Title: states the takeaway; plain words only (no code names, flag names, or terms the explanation defines later); a statement, not a pitch (no questions, teasers, emoji, trailing punctuation); bold on its own line.
   - Explainer: well formatted markdown (bold, bullets), zero points of confusion for a reader with no context.
   - Language: "Write the title and the explanation in the language the session's Language instruction names; if there is none, in the language the user has been writing in."
3. UI (Claude Code TUI): a one-line strip just above the prompt box: `Heads up · <learn line>`. Keys: `1: Learn more`, `2: Know this already`, `0: Dismiss` (also "not now", and an "off" to disable). After *Learn more* the explainer shows with `1: Understood`, `2: Chat in main session`, `0: Dismiss`. *Chat in main session* pastes a quoted note ("Here is a note offered by a side agent: > ...") into the prompt box and submits it; the main agent is told: "Answer straight away: do not think it over first, do not call any tool."
4. Backoff: after consecutive `learn: none` results the plugin skips more turns before asking again (exponential: 0 skipped turns for the first 2 misses, then 1, 2, 4, 8, capped at 16).
5. Everything is per session/thread. "Got it" topics persist across sessions (a `seen` list in the plugin store).

## Target UX in T3 Code (Toma's requirement: "really the same interface")

- A compact strip right above the composer of the thread: `Heads up · <learn line>` (or `You should know · ...`). Click/expand → title + explainer in a small card.
- Buttons: **Got it** (= understood, feeds the avoid list), **Not useful** (= dismiss, no list), **Ask in chat** (pastes the note into the composer as a quoted block and sends it, same text format as Claude Code).
- Works for every T3 provider (Claude, Codex, OpenCode, Pi, ACP…), for all active threads, each thread has its own strip.

## Architecture (two independent pieces)

### Piece 1 — minimal T3 Code patch (candidate upstream PR, "infra not feature")

T3 already has a `notification` turn item (`{source:{kind}, outcome, summary, detail?}`) rendered in the timeline, but only the server may create one (`message.dispatch` guard: "Notifications must be server- or provider-created queued messages"). Extend, minimally:

A. **Contracts** (`packages/contracts`): `notification.source.kind` gains `"external"` with `source.agent: string` (display name of the outside agent, e.g. "You should know"). Add optional fields on the notification item: `title?: string`, `body?: string` (markdown), `tag?: string`, `resolution?: "acknowledged" | "dismissed" | "asked"` (absent while open). `agent`, `summary`, `title`, `tag` are single lines.
B. **Server MCP tool** `t3_thread_notify` in the orchestrator toolkit, requires the `orchestration:operate` scope (read-only agents cannot post): `{threadId, summary, title?, body?, tag?, agent, clientRequestId}` → creates the external notification item without waking the agent (no user message). Returns `{notificationId}`.
C. **Resolve path**: a WS command (and MCP tool `t3_thread_notification_resolve`, read for symmetry) that sets `resolution` on an external notification; the client calls it from the buttons. Outside agents observe the resolution via `subscribeThread` / `t3_thread_read` so they can learn what was understood.
D. **Client** (`apps/web`): render the latest *open* external notification of the thread as a strip above the composer: `<tag> · <summary>`; expand shows `title` + `body`; buttons *Got it* → resolution `acknowledged`; *Not useful* → `dismissed`; *Ask in chat* → insert the note quoted into the composer and submit; resolution `asked` only once the send went through (with a draft in progress, the note waits at the end of the draft and the strip stays). The closing line is generic ("Answer this note straight away."), not the Claude Code tool ban, since a CI notice may need investigation. A second, different resolution is refused. Timeline card rendering of the item stays as today.

Keep the patch small and generic; wording of code/comments/commit in English; follow the repo's AGENTS.md / CONTRIBUTING.md conventions (tests required, no unrelated cleanup).

### Piece 2 — the daemon (`thomasfevre/t3-you-should-know`, our tool, outside T3)

- Node 24 + TypeScript, single process, no framework.
- Connects to the local T3 server as an *outside agent*: `server-runtime.json` in `~/.t3/userdata` gives `origin` (http://127.0.0.1:3773). Auth: a session token (the bundled CLI has `auth session issue`; investigate `apps/server/dist/bin.mjs` in the app bundle, or the pairing flow). Fallback if auth is painful: poll `~/.t3/userdata/statev2.sqlite` read-only (`orchestration_v2_projection_turn_items`, `orchestration_v2_projection_threads`, `orchestration_v2_projection_runs`) — never write to it.
- Watches all non-archived threads. Trigger = a root run reaching a terminal state (turn completed). Builds a compact transcript: user messages, assistant messages, short tool summaries (command + exit code, files changed), truncated to a token budget (newest kept).
- One model call per trigger with the prompt above (plus the two lists). Parse `learn: none` or the 4-part note.
- Model backends, configurable in `~/.config/t3-you-should-know/config.json`: `claude-cli` (default: `claude -p --model claude-haiku-5-5 --no-session-persistence`-style one-shot, uses the user's Claude subscription, no API key), `anthropic` (API key), `openrouter` (API key + model id). Default model: `claude-haiku-5-5`.
- Sinks, pluggable: `t3` (calls `t3_thread_notify` over MCP at `<origin>/mcp` — the tool from Piece 1; may not exist yet, so detect its absence and log), `macos` (osascript notification, for testing before Piece 1 lands), `stdout`.
- Feedback loop: reads notification resolutions (`acknowledged` → add learn line to the avoid list for that thread + global seen list; `dismissed` → nothing; `asked` → nothing). State in `~/.local/state/t3-you-should-know/state.json`: per thread last suggestions (max 10), consecutive misses (for backoff), global seen list.
- Backoff like the plugin. Cost guard: skip turns shorter than N new items; max 1 note per thread per X minutes.
- Reliability: the run watermark only drives discovery; each completed turn goes to a pending queue (one per thread, with a fixed clientRequestId) and is retried up to 3 times on model or delivery failure.
- Safety: the transcript is quoted as untrusted evidence (prompt rule, `</session>` escaped, output length limits mirror the tool schema).
- CLI: `t3-ysk run` (foreground), `t3-ysk once --thread <id>` (dry run, prints the model output), `t3-ysk status`.
- README in English, short.

### Piece 3 — upstream Ideas discussion post (English, <= 300 words)

Pitch the *infrastructure* only: "let an outside agent post a notice on a thread and learn how it was received". Motivate with 3 generic consumers (CI/PR watcher bots, reviewer agents, a watchdog like Claude Code's You-should-know). Point to the current guard and the existing `notification` item so the maintainers see it is an extension, not a new concept. State scope A–D above, ask for direction approval before the PR, per their CONTRIBUTING.md.
