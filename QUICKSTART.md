# Use Twitch Copilot

The plugin is installed locally. Start a fresh Codex chat (restart Codex if it still shows the older tools).

Say:

> Use Twitch Copilot. Connect my Twitch account and collect questions about my setup. Do not reply.

Codex shows a Twitch approval link. Open it, sign in to Twitch and approve access. Return to Codex and say:

> I approved Twitch. Finish connecting and watch chat for two minutes.

Try changing the filter:

> Only show messages starting with !ask.

To allow public replies:

> Answer !ask questions briefly. Enable replies, with at least five seconds between them.

To stop:

> Disconnect Twitch.

No terminal commands, access-token copying, client secret or separate website is needed for normal sign-in. Twitch Copilot uses its registered public client ID, which is safe to distribute. Credentials are saved privately on your computer. If authorization expires, repeat the approval link flow. The optional local semantic model is not needed for the basic demo.

You can test from your own Twitch account: type `!ask hello`. Ordinary messages from your account are suppressed to prevent bot echo loops, but explicit `!ask` commands pass through. Other viewers can use the same command. Replies require explicit enablement and an active Codex watch session.
