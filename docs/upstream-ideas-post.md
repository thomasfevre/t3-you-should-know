# Upstream Ideas post

Publish only the "Post" section below, as a new discussion in pingdotgg/t3code > Ideas. The internal notes stay here.

## Title

Let outside agents post a notice on a thread

## Post

Outside agents connected over MCP can read and message threads. They cannot leave a notice that does not interrupt the agent.

The only way to surface something today is a user message through `t3_thread_send`, and that wakes the agent.

T3 already has a `notification` turn item, but only the server or a provider may create one. The dispatch guard says "Notifications must be server- or provider-created queued messages". I propose a small extension:

- Contracts: the notification source gains an `external` kind with an agent name. The item gains optional `title`, `body`, `tag` and a `resolution` that is empty while open.
- MCP tool: `t3_thread_notify` posts one without waking the agent. Read-only clients are refused, like other tools that change the environment.
- Resolve command: the client marks a notice acknowledged, dismissed or asked. Outside agents see the result when they read the thread.
- Composer strip: the latest open external notice shows above the composer, with an expandable body and three buttons: Got it, Not useful, Ask in chat. The last one quotes the notice into the composer.

Three generic consumers:

- A PR or CI watcher posts "checks failed on the latest push" without starting a turn.
- A reviewer agent leaves findings on a thread it did not start.
- A watchdog like Claude Code's built-in "You should know" explains something the user likely missed, then learns whether it landed.

This differs from #21240 and #18104, where the message still reaches the agent (now or on its next run), and from #19500, which is a push sent by the agent itself.

We have a working patch and a demo. Per CONTRIBUTING.md, we would like maintainer approval of the direction and scope before opening a PR.

---

# Internal notes (do not publish)

## Duplicates checked

Searched Ideas discussions for notification, outside agent, external, banner, MCP and notice, plus issues for "notification". No exact duplicate. Closest:

- [#21240](https://github.com/pingdotgg/t3code/discussions/21240) Automation messages: an outside relay wakes the agent, rendered as a folded notification. Ours never wakes the agent and adds a resolution that flows back to the outside agent. Same notification item, different intent. Worth cross-linking.
- [#18104](https://github.com/pingdotgg/t3code/discussions/18104) Let an agent send a thread a message without starting a run: a message held for the agent's next run. Ours is for the human, never delivered to the agent unless they ask. Linked from #21240.
- [#19500](https://github.com/pingdotgg/t3code/discussions/19500) `notify_user` MCP tool: the in-thread agent sends a push. Ours is for outside agents and is an in-app strip with feedback, not a push.
- [#19534](https://github.com/pingdotgg/t3code/discussions/19534) MCP Events: outside agents learn about thread events. Opposite direction. Ours is outside agent to thread. Complementary.
- [#14072](https://github.com/pingdotgg/t3code/discussions/14072) Let a tool mark a thread as waiting: changes thread status, not a user-facing notice.
- [#6839](https://github.com/pingdotgg/t3code/discussions/6839) Suggest a follow-up prompt: T3 generates it with its own text model and the click inserts a prompt. Ours is generated outside T3 and carries a resolution.
- [#17212](https://github.com/pingdotgg/t3code/discussions/17212) Orchestrator hears from its workers: server-owned notices between T3 threads, not outside agents.
- [#16993](https://github.com/pingdotgg/t3code/discussions/16993) Agents send feedback to the T3 team: different recipient.

## Sources

Upstream pingdotgg/t3code at 968dd51704 (read in the local clone ~/dev/t3code, which has no upstream remote, so line content matches that commit and was not re-fetched):

- CONTRIBUTING.md (prior approval and Ideas discussions rules)
- docs/user/outside-agents.md (read-only default, Supervised to Full access)
- packages/contracts/src/orchestrationV2.ts (`OrchestrationV2NotificationSource`, `OrchestrationV2Notification`, turn item `type: "notification"`)
- apps/server/src/orchestration-v2/Orchestrator.ts (the dispatch guard text)
- apps/server/src/mcp/toolkits/orchestrator/tools.ts (`t3_thread_send`, tool declarations)
- apps/server/src/mcp/McpToolAccess.ts (`refuseReadOnlyClient`)
- packages/contracts/src/auth.ts (`AuthOrchestrationOperateScope`)
- Discussions listed above, read via `gh api graphql`
- /tmp/ysk/SPEC.md (Piece 1, Piece 3)
