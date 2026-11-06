# BB support

Investigated on 2026-11-06. All BB access was read-only. No settings, plugin files or running services were changed.

## Process identity

`~/.bb/plugins/provider-claude-code` and `provider-codex` contain runtime data directories, not the current bundles. The installed code is in `~/.bb/plugin-host-artifacts/provider-{claude-code,codex}/<hash>/host.mjs`.

Claude's bundle constructs sessions with `threadId`, `providerThreadId` and a session identity. The Codex bundle sets `shell_environment_policy.set.BB_THREAD_ID` from its thread ID. This shell setting does not establish that a shared Codex hook process has a per-thread environment.

A filtered `ps eww -axo pid=,command=` inspection found running BB descendants carrying `BB_THREAD_ID`, `BB_CLI`, `BB_SERVER_URL`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID` and `BB_THREAD_STORAGE`. Only allowlisted identity values were printed; the full environment was never emitted. Do not use server URLs, cwd, parent process names or storage paths as thread identities.

## Database contract

`~/.bb/bb.db` is opened with Node SQLite `readOnly: true`. Investigation used `sqlite3 -readonly`.

- `threads`: `id`, `provider_id` (`claude-code` or `codex`), title, millisecond update/archive/delete timestamps. Includes plugin-created coordinators, workers and reviewers.
- `events`: per-thread increasing `sequence`, `turn_id`, `provider_thread_id`, `type`, JSON `data`, millisecond `created_at`.
- `thread/identity` binds the provider's native session to the BB thread. Repeated identical events are normal. Multiple distinct matching threads are ambiguous and rejected.
- `client/turn/requested` contains `input` text blocks. `turn/input/accepted` contains a request ID, not user text.
- `item/completed` contains `data.item`: `agentMessage`, `commandExecution`, `toolCall`, `fileChange`, etc. Streaming deltas are ignored. Unsupported items are omitted.
- `turn/completed` supplies terminal status; only `completed` triggers analysis.
- `prompt_history_entries` is a search projection with `project`/`thread` scopes; it is not a turn table and is not needed by the adapter.

## Resolution and storage

A hook carrying `BB_THREAD_ID` must also supply a native `session_id` bound uniquely to that exact BB thread and provider. Without the thread ID, `BB_CLI` plus a unique native session binding is required. Missing, conflicting or malformed evidence produces nothing, with exit code 0. First prompts may precede identity persistence and are safely skipped. No changes to BB are required for the observed contract. Codex hook delivery still depends on Codex actually invoking the configured hook; shell environment injection alone does not verify that live behavior.

BB state, inbox, pending analysis, queue and toggles use `bb:<thread-id>`. Legacy T3 IDs remain unchanged to preserve existing notes and switches. Discovery merges both sources by completion timestamp before advancing the existing cursor. If a present source cannot be read, discovery fails without advancing past its unseen events. Missing database files are skipped; existing incompatible schemas report errors.

`sources` defaults to `["t3", "bb"]`; use `["t3"]` or `["bb"]` to restrict it. `bbDbPath` defaults to `~/.bb/bb.db`. BB includes worker/reviewer threads; the existing T3 child-prefix filter remains T3-specific. Model, redaction, note expiry and inline delivery behavior are shared.

## Reload and verify after installation

The installed launchd job still points to `/Users/toma/dev/t3-you-should-know`, not this worktree. Updating that installation is a separate action. After the reviewed code is installed there:

```sh
launchctl kickstart -k gui/$(id -u)/com.thomasfevre.t3-you-should-know
/Users/toma/.local/share/vite-plus/js_runtime/node/26.13.0/bin/node /Users/toma/dev/t3-you-should-know/bin/t3-ysk.mjs status
/Users/toma/.local/share/vite-plus/js_runtime/node/26.13.0/bin/node /Users/toma/dev/t3-you-should-know/bin/t3-ysk.mjs queue --thread bb:<BB_THREAD_ID> --learn "test"
```

Send another prompt in that BB chat. The agent should receive the queued line and show it at the start of its reply. In the chat, run `off`, queue another test, and send another prompt to check suppression; run `on` to restore it. A queued note requires a daemon tick before the next prompt. Live reload and chat delivery were not run during implementation.
