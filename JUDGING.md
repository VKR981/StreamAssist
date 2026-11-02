# Install and test Twitch Copilot

## Requirements

- A supported local Codex client with plugin support and a working `codex` CLI.
- Node.js 24+ on the host PATH.
- A normal Twitch account for the real integration. A developer application or client secret is not needed by each tester; the public application client ID is bundled.
- pnpm is required only for rebuilding source or running the developer tests. The bundled runtime is ready to launch.

## Install from a clone or extracted package

From the project directory:

```sh
codex plugin marketplace add "$PWD"
codex plugin add twitch-copilot@twitch-copilot-local
```

Restart the desktop client or start a fresh local Codex chat to load the installed plugin's tools and skill. Confirm it appears enabled in the plugin list. The local MCP server is launched from the installed plugin directory; no separate web app or hosted backend is required.

## Real Twitch test

1. Ask Codex: “Use Twitch Copilot. Connect my Twitch account. Only collect !ask messages; do not reply.”
2. Open the returned official Twitch activation link and approve access. Return to Codex and say approval is complete; it finishes authorization and connects the channel.
3. Ask Codex to watch chat for two minutes. Open your Twitch channel's chat and type `!ask hello` from the authorized account or another account.
4. Confirm the matching message appears in Codex.
5. Explicitly request replies: “Enable replies to !ask messages, keep answers short, and watch for two minutes.” Type another !ask message and confirm an answer appears on Twitch. The default cooldown is five seconds.
6. Say “Disconnect Twitch” to stop.

The channel can be offline. Ordinary messages from the authenticated account are suppressed as possible bot echoes, while explicit !ask commands are accepted. The assistant only responds while Codex is actively watching. Chat content does not authorize code execution, file edits or changes to the agent's permissions.

## Credential-free test

In Codex:

> Use Twitch Copilot in demo mode. Show questions about my setup and keep replies disabled.

This uses deterministic synthetic messages and an in-memory outbox. It does not connect to Twitch or demonstrate live message delivery.

## Developer checks

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm demo
pnpm validate
```

The test suite has 53 tests. The optional local Ollama classification path is not required and has not been verified with a running model.

## Troubleshooting

- Missing tools after installation: start a fresh local chat or restart the client, then check the plugin is enabled.
- No messages: establish the connection before sending a new test message; EventSub does not replay messages sent before subscription. Check the current filter and use a fresh !ask command.
- No public reply: check that the streamer explicitly enabled replies and that Codex is still in an active watch session.
- Authorization expired: repeat the browser sign-in flow. Do not paste tokens into the chat.
- Node not found: install Node 24+ and make it available on the Codex host's PATH.
