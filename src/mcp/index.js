#!/usr/bin/env node

/**
 * Twitch Copilot MCP Server entrypoint.
 * Connects standard I/O transport to communicate with OpenAI Codex / Claude hosts.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTwitchCopilotServer } from './server.js';

async function main() {
  const server = createTwitchCopilotServer();
  const transport = new StdioServerTransport();

  process.on('SIGINT', async () => {
    try {
      await server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    try {
      await server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });

  await server.connect(transport);
}

main().catch((err) => {
  // Use stderr so we do not disrupt JSON-RPC protocol on stdout
  process.stderr.write(`Twitch Copilot fatal startup error: ${err.message}\n`);
  process.exit(1);
});
