# Orcode

Orcode gives a Codex CLI session and a Claude Code CLI session an explicit,
local way to discover and message each other. Each agent stays in its own
terminal and keeps its own permissions, context, and approval policy.

```text
Codex TUI  <-> dedicated Codex app-server <-> orcode MCP
                                               |
                                  private live-session registry
                                               |
Claude TUI <-> Claude native ListAgents/SendMessage <-> orcode MCP
```

There is no network broker. Orcode stores only short-lived routing metadata;
message bodies are handed directly to the provider and are never written to
Orcode's registry.

## Requirements

- POSIX-like local machine (Linux/macOS)
- Node.js 24 or newer
- Codex CLI 0.151.0 or newer
- Claude Code CLI 2.1.236 or newer

Run `orcode doctor` to check the local setup.

## Install

From this checkout:

```sh
pnpm install
npm link
```

Once published, the package can instead be installed with
`npm install --global orcode` or `pnpm add --global orcode`.

## Start two managed peers

Open two terminals in the same repository:

```sh
orcode codex
```

```sh
orcode claude
```

When `--name` is omitted, Orcode generates and prints a provider-prefixed peer
name such as `codex-a3f29c10` or `claude-b91c047e`. Use explicit names when you
want stable, role-based addresses:

```sh
orcode codex --name implementer
orcode claude --name reviewer
```

Provider options go after `--`:

```sh
orcode codex --name implementer -- --model gpt-5.4
orcode claude --name reviewer -- --model opus
```

Resume identifiers are wrapper options:

```sh
orcode codex --name implementer --resume <thread-id> --
orcode claude --name reviewer --resume <session-id> --
```

Omitting `--name` while resuming generates a new routing name for that run.

For Codex, pass `--resume` only for a session that succeeds with
`codex resume <thread-id>` on its own. In particular, Codex 0.153.2 does not
resume an empty thread that has no persisted rollout yet. New Orcode sessions
do not use the resume path: the TUI creates the thread and Orcode observes and
registers it after it is loaded.

The wrapper injects the Orcode MCP server. Ask either agent to call
`list_peers`, then to call `send_message` with an exact address such as
`claude:reviewer` or `codex:implementer`.

From a shell, `orcode peers` lists live peers in the current project.
`orcode peers --all-projects --json` is useful for diagnostics. Git worktrees
with the same common Git directory are treated as one project.

## Messaging contract

The MCP server exposes two tools:

- `list_peers({ allProjects?: boolean })`
- `send_message({ to, message, replyTo? })`

Messages are one-to-one and limited to 64 KiB of UTF-8 text. There are no
attachments, broadcasts, delivery retries, automatic replies, or remote
connections. A successful send means the receiving provider accepted the
message; it does not promise that the model has read or acted on it.

Every delivery is wrapped in a versioned JSON envelope containing sender,
recipient, timestamp, message id, and body. The receiver is explicitly told to
treat the body as untrusted peer context. A peer message cannot expand the
receiver's permissions or override its higher-priority instructions.

## Runtime and discovery

Managed sessions register under `$XDG_RUNTIME_DIR/orcode`, falling back to
`/tmp/orcode-$UID`. The directory is mode `0700`; record files are atomic and
mode `0600`. Records contain names, PIDs, project identity, and provider routing
coordinates only. Dead PIDs and missing Codex sockets are pruned on reads.

Claude sessions started outside Orcode may appear when `claude agents --json`
provides enough addressing and working-directory metadata. Unmanaged Codex
sessions are not guaranteed to be addressable, so the wrapper is recommended.

## Provider plugin bundles

Reusable plugin bundles live at:

- `integrations/codex/plugins/orcode`
- `integrations/claude/plugins/orcode`

They contain matching MCP configuration and a narrowly scoped peer-messaging
skill. They are ready to embed in a team or repository marketplace. The
wrappers do not require plugin installation; they inject the same MCP server
directly so a fresh local install works immediately.

Orcode runs its TypeScript source directly on Node.js 24. There is no bundling,
transpilation, or build step; the source is constrained by TypeScript's
`erasableSyntaxOnly` check.

## Development

```sh
pnpm check
```

The test suite does not make model calls. It covers registry lifecycle,
message envelopes and limits, project/worktree identity, routing behavior, and
an end-to-end MCP stdio handshake using Node's built-in `node:test` runner.
