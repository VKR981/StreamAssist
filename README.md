# Twitch Copilot (OpenAI Codex Plugin)

A streamer-controlled Twitch chat companion plugin for OpenAI Codex live coding sessions. Connects Twitch directly via a local Model Context Protocol (MCP) server process—with **no external web applications, no hosted backends, and no cloud databases**.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       OpenAI Codex                          │
│        (Conversational Agent & Live Coding Assistant)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ JSON-RPC (MCP via stdio)
┌──────────────────────────────▼──────────────────────────────┐
│                  Twitch Copilot MCP Server                  │
│                                                             │
│  ┌────────────────────┐   ┌──────────────────────────────┐  │
│  │ MessageBuffer      │   │ MessageFilter                │  │
│  │ (Bounded, Ring,    │   │ (Keywords, Questions-only,   │  │
│  │  Dedup, Cursors)   │   │  Prefixes, Optional Ollama)  │  │
│  └─────────▲──────────┘   └──────────────▲───────────────┘  │
│            │                             │                  │
│  ┌─────────┴─────────────────────────────┴───────────────┐  │
│  │ Transports:                                           │  │
│  │  - SyntheticTransport (Credential-Free Demo & Tests)   │  │
│  │  - EventSubClient (Real Twitch WebSocket + Handover)  │  │
│  │  - TwitchChatClient (Helix API + Rate Limiter)        │  │
│  └────────────────────────┬──────────────────────────────┘  │
└───────────────────────────┼─────────────────────────────────┘
                            │ Outgoing / Inbound WSS
                            ▼
              ┌───────────────────────────┐
              │    Twitch EventSub WSS    │
              │  & Helix Chat REST APIs   │
              └───────────────────────────┘
```

- **Local MCP Process**: Codex launches the plugin's local Node process.
- **Direct Twitch EventSub WebSocket**: The local process connects directly to Twitch's official EventSub WebSocket (`wss://eventsub.wss.twitch.tv/ws`).
- **Turn-by-turn Bounded Waits**: Codex monitors chat through explicit `wait_for_messages(cursor, timeout <= 25s)` calls during active sessions. No always-on background agent or unprompted idle wakeup.
- **Strict Untrusted Data Model**: All viewer chat is treated strictly as data. The connector exposes no viewer-controlled execution tools; the skill instructs Codex to treat viewer text as untrusted and never execute it. Instructions do not constitute a sandbox security guarantee.
- **Streamer Control Only**: Replies are disabled by default. The streamer must explicitly enable replies and set rate budgets.

---

## Installation & Setup

### Prerequisites
- Node.js 24+ (`node -v`)
- pnpm 10+ or 11+ (`pnpm -v`)

### 1. Install Dependencies Locally
```bash
pnpm install --frozen-lockfile
pnpm build
```

### 2. Run Tests
```bash
pnpm test
```

### 3. Run Credential-Free MCP Demo
```bash
pnpm run demo
```

### 4. Build Distribution Package
```bash
pnpm run package
```
Generates `dist/twitch-copilot.zip` strictly excluding credentials, `node_modules`, and test artifacts.

---

## Installing into Local Codex

From this project directory, register and install the local plugin using the CLI:

```bash
codex plugin marketplace add "$PWD"
codex plugin add twitch-copilot@twitch-copilot-local
```

Alternatively, after registering the marketplace, open the desktop Plugins Directory, select **Twitch Copilot**, and install it. Restart or start a fresh Codex chat so its skill and tools are loaded. A fresh chat is needed because this build did not install or enable the plugin in your global settings.

The repository includes `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, `.mcp.json`, and `skills/twitch-copilot/SKILL.md`. MCP uses a plugin-relative working directory (`cwd: "."`) and script path (`./build/server.cjs`), resolved by Codex at installation. The distribution ZIP includes a self-contained `build/server.cjs`; Node 24 must be on the host's PATH. Source checkouts need `pnpm install --frozen-lockfile` followed by `pnpm build` before installation. The extracted ZIP can use `node build/setup-auth.cjs` for credentials without installing dependencies. 

Start with this in a new Codex chat:

> Use Twitch Copilot in demo mode. Collect questions about my setup. Show the matching questions here. Do not post any replies.

For real chat, say **“Use Twitch Copilot. Connect my Twitch.”** Open the Twitch approval link returned by Codex. After approving, say **“I approved Twitch; finish connecting.”** No terminal command or pasted token is needed. See [QUICKSTART.md](QUICKSTART.md).

**Verification:** the installed Codex CLI recognizes this repository as `twitch-copilot@twitch-copilot-local` when supplied the local marketplace configuration. The Node MCP client exercises all eleven tools. Desktop installation, real Twitch authorization and a real Ollama model have not been tested here. The synthetic demo does not prove live access or model behavior.

---

## Browser authorization

The registered public client ID is bundled. Streamers authorize their own Twitch accounts using the official device authorization flow:

1. Ask Codex to connect Twitch.
2. Open the returned Twitch approval link and approve `user:read:chat` / `user:write:chat`.
3. Tell Codex approval is complete. It calls `complete_twitch_login`, saves credentials locally and connects chat.

Tools `begin_twitch_login`, `complete_twitch_login`, and `cancel_twitch_login` handle this flow. Device and access tokens never appear in tool responses. The public application client ID is not a secret. No client secret or hosted server is used. Tokens expire; repeat this flow to reauthorize. Refresh tokens are stored privately for future refresh support; automatic refresh is not currently implemented.

Credentials use an owner-only local file under `~/.config/twitch-copilot/` (or the OS-equivalent path). Developers can override with `TWITCH_COPILOT_CONFIG` or supply `TWITCH_CLIENT_ID` and `TWITCH_ACCESS_TOKEN` in their environment. The old terminal setup is an advanced development fallback, not the normal streamer workflow.

---

## Tools Reference

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `connect_channel` | `channel?: string, demo?: boolean` | Connects to Twitch chat. Pass `demo: true` for credential-free testing. Default observe-only. |
| `connection_status` | *(none)* | Returns connection state, filter settings, reply policy, and message buffer stats. |
| `read_chat` | `cursor?: number, limit?: number` | Reads buffered messages beyond cursor. Returns `next_cursor` and truncation indicator. |
| `wait_for_messages` | `cursor?: number, timeout?: number` | Waits asynchronously up to `timeout` (capped at <=25s) for new matching messages. |
| `set_chat_filter` | `include_keywords, exclude_keywords, questions_only, command_prefixes, semantic_filter` | Translates natural language requests into structured filters. |
| `set_reply_policy` | `enabled: boolean, max_chars?: number, cooldown_seconds?: number, max_replies_per_minute?: number` | Streamer-only: enables/disables replies and tunes cooldowns. |
| `send_reply` | `message: string, in_reply_to?: string` | Sends an authorized reply (validates <=500 chars, cooldowns, inspects Twitch `is_sent`). In demo mode, writes to in-memory outbox. |
| `disconnect` | *(none)* | Disconnects WebSocket, cleans up timers, and flushes queues. |

---

## Troubleshooting

- **Token Expired / HTTP 401**:
  Twitch user tokens expire or can be revoked. Re-run `pnpm run setup-auth` or refresh via Twitch CLI. Twitch Copilot does not fabricate token refreshes without refresh credentials.
- **WebSocket Reconnect Handover**:
  When Twitch migrates EventSub servers, it issues a `session_reconnect` message with a `reconnect_url`. Twitch Copilot implements the documented handover flow: connecting to the new URL, verifying welcome, swapping the active socket, and detaching the old socket while preserving the existing subscription. An ordinary network outage can lose messages; Twitch does not replay them.
- **Rate Limits (HTTP 429)**:
  Twitch Helix enforces rate limits on chat messages. Twitch Copilot reads `Retry-After` headers and pauses outgoing sends until the backoff window elapses.

---

## Hackathon Attribution & Checklist

- **Development Attribution**:
  - Codex authored the initial implementation, scripts, documentation and tests as requested. Codex specified the design, reviewed the code, corrected integration and lifecycle issues, and added integration regression tests.
  - Codex plugin schema, manifests, and skill designed for OpenAI Codex plugin ecosystem.
  - No claim is made that AGY work was authored by Codex.
- **Eligibility Notice**:
  - Hackathon organizers determine final eligibility based on submission requirements.
- **Deliverables**:
  - `dist/twitch-copilot.zip` generated via `pnpm run package`.
  - Credential-free integration demo runnable via `pnpm run demo`.
  - Complete `node:test` suite runnable via `pnpm test`.

---

## License

MIT License. See [LICENSE](LICENSE) for details.


## Filtering behavior and limits

Codex translates the streamer's natural-language request into structured tool arguments. Keyword/question/prefix rules are heuristics, not semantic AI classification. An optional explicitly configured local Ollama model can classify meaning; no model is downloaded or started automatically, and no OpenAI API key is needed for this plugin's default mode. It uses the streamer's existing Codex access.

Changing a structured filter also refilters retained messages. Semantic changes clear retained history. Previously discarded messages cannot be recovered by widening a filter. Filters select what Codex reads; they do not hide, delete or moderate public Twitch chat. Semantic errors and queue overflow are exposed in `connection_status.last_event`; failed classifications are excluded rather than silently accepted.

Live mode is restricted to the authenticated streamer's own channel. A reconnect disables replies until the streamer enables them again. Chat messages are buffered only in memory and disappear when the connection or process ends. The plugin receives chat, not stream audio or video.

## Submission checklist

- Publish the source repository with installation instructions and licensed assets.
- Explain the Codex and AGY contributions accurately and include this build's Codex session ID.
- Record a public YouTube demo under three minutes showing **real Twitch chat**, plus Codex build/review footage. The synthetic demo is for development and does not replace this footage.
- Keep the project accessible to judges through the judging period; confirm all official eligibility and timing requirements.

Suggested video: 20 seconds for the problem, 60 seconds for live chat filtering, 40 seconds for an authorized reply and a changed filter, 40 seconds for Codex build/review footage, and 15 seconds for setup/results.


## Testing from the streamer account (0.2.1)

You can type `!ask hello` from the same Twitch account used to authorize the plugin. Explicit !ask commands are accepted; ordinary messages from that account remain suppressed as potential bot echoes. Outgoing assistant replies cannot begin with !ask, preventing self-reply loops. A plain `hi` is not matched by an !ask filter.

Changing set_chat_filter replaces the previous rules, so switching from questions-only to !ask also removes the old question restriction. Codex must be in an active watch session and the streamer must explicitly enable replies before any public answer is sent. Installation and authorization alone do not start an autonomous always-on agent.


### Moderation
Version 0.3.0 adds deletion of a specific message, timeouts, bans, and unbans. Sign in again to grant moderation scopes, connect, and tell Codex which actions to enable and the rules to apply. Example: “Enable deletion only; delete messages containing MODERATION_DEMO for this test.” Send the test from a separate ordinary viewer account. Codex must be actively watching. Moderation resets on disconnect; demo mode only simulates actions. Natural-language decisions are made by the active Codex session; no separate classifier or autonomous moderation worker is included.

### Automatic startup (0.3.2)
Ask Codex to use Twitch Copilot with the streamer instruction file. Startup checks chat and moderation permissions by default and requests Twitch approval if needed. Completing approval automatically connects the channel; Codex then applies the already authorized instructions and starts the watch without a separate reconnect prompt. An explicitly chat-only session can use connect_channel(moderation=false). Twitch consent still requires the streamer’s approval.
