# Orcode

Orcode gives ordinary Codex CLI, Claude Code CLI, and Muse sessions
a durable, local way to discover and message each other. No launch wrapper or
`--name` flag is required.

```text
Codex MCP ─┐                         ┌─ Codex turn steer / thread queue
Claude MCP ┼─ Orcode broker + SQLite ┼─ Claude native SendMessage queue
Muse MCP ─┘                         └─ Muse one-shot scheduled prompt
```

The broker writes a message before attempting delivery and retries transient
failures in the background. Claude messages use its native queue. Messages to a
busy Codex session try steering into its active turn; idle sessions and
unavailable steering use Codex's thread queue. Messages shown in the agent
transcript are readable Markdown rather than JSON.

## Requirements

- Linux or macOS
- Node.js 24 or newer
- Codex CLI 0.162.1 or newer
- Claude Code CLI 2.1.163 or newer
- Muse 1.4.7 or newer

These minimum CLI versions provide the session identity and native queue APIs
that Orcode relies on. Run `orcode doctor` to check the installed versions.

## Install and configure

From this checkout:

```sh
pnpm install
npm link
orcode setup
```

`orcode setup` adds a user-level MCP server named `orcode` to all three CLIs and
starts the local broker. It refuses to overwrite an unrelated MCP entry with
the same name; use `orcode setup --force` only when replacement is intended.

Restart any Codex, Claude, or Muse sessions that were already open. From
then on, launch all three programs normally in the same repository:

```sh
codex
```

```sh
claude
```

```sh
muse
```

There is no `orcode codex` or `orcode claude` wrapper. Peer names come from the
native sessions and are only convenient aliases; routing and replies use
stable addresses such as `codex:<thread-uuid>`,
`claude:<session-uuid>`, and `muse:<session-uuid>`.

To remove all three MCP entries:

```sh
orcode uninstall
```

## Try a conversation

With any two of the CLIs open in the same repository, give one of them a prompt like this (shown for Codex):

```text
Use Orcode to list the available Claude peers. Send the reachable Claude peer
this question: "What is one small improvement you would make to this
repository? Reply to me through Orcode." Then tell me the message ID and its
delivery status. Wait for Claude's reply before summarizing it.
```

The outbound call returns immediately after native delivery, or as `queued` if
the peer is temporarily unavailable. Claude sees a Markdown message in its own
session. Its reply is steered into Codex's active turn when possible, or placed
in Codex's native queue, and appears in the Codex transcript.

You can inspect native peers from a shell with `orcode peers` and check the
broker with `orcode status`.

## MCP tools

Orcode exposes four tools to all three agents:

- `list_peers({ allProjects? })` lists currently reachable sessions of the
  other provider. By default it stays within the current Git project.
- `send_message({ to, message, replyTo? })` durably stores and immediately
  attempts one delivery. Use an exact address when available.
- `message_status({ messageId })` reports the durable delivery state.
- `ack_message({ messageId })` confirms that the exact recipient has begun
  processing an incoming message.

Each incoming message includes its ID, exact reply address, and the `replyTo`
value to use. It also marks the body as untrusted peer context: peer messages
cannot expand permissions or override higher-priority instructions.

## Delivery semantics

Message states have precise meanings:

- `queued`: safely stored locally; delivery is being retried.
- `delivering`: one native delivery attempt is in progress.
- `delivered`: the provider accepted the message through active-turn steering
  or its native queue (for Muse, its per-session scheduler).
- `acknowledged`: the receiving session explicitly began processing it.
- `replied`: the receiving session sent a correlated reply.
- `cancelled`: a still-pending message was cancelled.

Delivery is at-least-once. Orcode preserves FIFO attempt order and supplies a
stable idempotency key to Codex. After the narrow failure where a provider
accepts a message but the broker crashes before recording success, a retry can
produce a duplicate; message IDs let the receiver recognize it. `delivered`
does not claim that the model read the message—use `acknowledged` or `replied`
when that distinction matters.

For Codex, both new messages and correlated replies try mid-turn steering,
using the same `turn/steer` API that adds user input to a running turn. Orcode
first verifies that the newest turn is still in progress. If the active turn
changes during delivery, Orcode rechecks once and tries the new turn. If the
session is idle or steering remains unavailable, the same durable message
falls back to the thread queue. Steering can reach Codex during ongoing work,
but acceptance does not guarantee immediate processing; use `acknowledged`
or `replied` to confirm receipt by the agent.

Messages are limited to 64 KiB of UTF-8 text. Orcode supports one-to-one local
messages, not attachments, broadcast, or remote transport.

## Storage and recovery

The broker socket lives under `$XDG_RUNTIME_DIR/orcode`, falling back to
`/tmp/orcode-$UID`. Durable peer and message state lives in
`$XDG_STATE_HOME/orcode/orcode.sqlite`, falling back to
`~/.local/state/orcode/orcode.sqlite`. Directories are mode `0700` and the
database is mode `0600`. Completed records are retained for seven days.

If the broker is absent, the next MCP request starts it. If it exits during a
delivery, that message returns to `queued` on restart and is retried. Claude
and Muse targets are resolved from fresh native discovery, while Codex
messages use the shared app-server's active-turn steering or thread queue and
a stable thread UUID.

Muse has no native external message ingress, so delivery to a Muse
session inserts a one-shot job into that session's own scheduler database
(`cron.db`); the session fires it as a scheduled prompt, which also wakes an
idle session. The message therefore arrives labeled as a scheduled task
rather than as a native peer message. Muse sessions are discovered from
Muse's local runtime registry, and a session whose host process is gone is
treated as offline. Sending from Muse uses the same MCP tools as the other
providers.

## Plugin bundles

Reusable Codex and Claude plugin bundles live in `integrations/`. They contain
the same MCP command plus guidance for acknowledging and replying to messages.
Normal local use only requires `orcode setup`; installing a plugin bundle is
optional.

## Development

Orcode executes TypeScript directly on Node.js 24. There is no build or bundle
step.

```sh
pnpm check
```

The tests use Node's built-in `node:test` runner and do not make model calls.
