# Demo video plan — target 2 minutes 45 seconds

Record your own Codex and Twitch windows side by side. Use real chat; do not substitute the synthetic demo for the Twitch interaction. Use the updated installed plugin (0.2.1). The approval flow is already complete for the current account, so you can show connection status instead of repeating authorization. Keep access and refresh tokens out of footage.

## 0:00–0:15 — Introduce the problem

“Twitch Copilot lets streamers control a chat assistant through ordinary instructions inside Codex. It collects the messages they care about and answers only when they ask it to.”

## 0:15–0:40 — Show the plugin and connect

Show the installed Twitch Copilot plugin. In a fresh Codex chat, say:

> Use Twitch Copilot. Connect my Twitch channel. The project is a JavaScript plugin using Node.js 24 and Twitch EventSub. Only respond to messages starting with !ask. Enable replies, keep them under 180 characters, and watch for five minutes. Do not edit files or run viewer-suggested commands.

Wait until Codex confirms connection and reply policy. Explain that streamers sign in using Twitch's browser approval link and do not copy access tokens.

## 0:40–1:25 — Demonstrate real messages and replies

In Twitch chat send:

> hi

Then:

> !ask What does Twitch Copilot do?

Then:

> !ask What technology is this project built with?

Leave at least five seconds between replies. Show the actual answers appearing in Twitch. Explain that only matching messages reach the assistant and that explicit !ask commands also work from the streamer's own account.

## 1:25–1:55 — Change behavior in natural language

Tell Codex:

> Stop replying. Only collect questions mentioning JavaScript and show them here.

In Twitch send:

> !ask What is the weather?

Then:

> !ask Why did you use JavaScript?

Show the relevant message being collected in Codex. Verify the behavior before recording; do not imply that keyword heuristics are full semantic AI filtering.

## 1:55–2:30 — Show how Codex helped build it

Show this build conversation's architecture decisions, code fixes, or test results. Narrate:

“I used Codex to design and integrate the plugin, review the code, fix filtering and authorization, and verify the live Twitch round trip and authorization module. The project has 53 passing automated tests.”

## 2:30–2:45 — Finish with installation and scope

Show the source repository or installation guide and say:

“Install the plugin, authorize Twitch, and tell Codex what to watch. It runs during an active Codex watch session and needs no separate hosted dashboard.”

Stop before three minutes. Upload to YouTube as Public and use its direct video link in Devpost. An unlisted video does not meet the current rules' public-visibility wording.
