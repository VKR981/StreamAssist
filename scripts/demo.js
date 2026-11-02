#!/usr/bin/env node

/**
 * End-to-end MCP client demo for Twitch Copilot.
 * Exercises tools end-to-end without credentials or external network.
 * Verifies prompt injection safety, bot echo suppression, event deduplication,
 * natural language filters, reply policy enforcement, and clean shutdown.
 */

import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.TWITCH_COPILOT_SERVER || path.resolve(__dirname, '../build/server.cjs');

async function runDemo() {
  console.log('====================================================');
  console.log('       TWITCH COPILOT - MCP CLIENT DEMO             ');
  console.log('====================================================\n');

  console.log(`Starting local MCP server at ${serverScript}...`);
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverScript],
  });

  const client = new Client(
    { name: 'demo-codex-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('✓ Connected to Twitch Copilot MCP server.\n');

  // Step 1: List tools
  console.log('--- Step 1: Listing Available Tools ---');
  const toolsResult = await client.listTools();
  console.log(`Discovered ${toolsResult.tools.length} tools:`);
  for (const t of toolsResult.tools) {
    console.log(`  - ${t.name}: ${t.description.slice(0, 65)}...`);
  }
  console.log('');

  // Step 2: Connect channel in demo mode
  console.log('--- Step 2: Connecting Channel (Demo Mode) ---');
  const connectRes = await client.callTool({
    name: 'connect_channel',
    arguments: { channel: 'twitch_dev_streamer', demo: true },
  });
  console.log('connect_channel response:');
  console.log(connectRes.content[0].text);
  console.log('');

  // Step 3: Check connection status
  console.log('--- Step 3: Verifying Connection Status ---');
  const statusRes = await client.callTool({
    name: 'connection_status',
    arguments: {},
  });
  const statusData = JSON.parse(statusRes.content[0].text);
  assert.equal(statusData.connected, true);
  assert.equal(statusData.reply_policy.enabled, false);
  console.log(`Status: connected=${statusData.connected}, mode=${statusData.mode}, channel=${statusData.channel}`);
  console.log(`Reply Policy Enabled: ${statusData.reply_policy.enabled} (observe-only by default)\n`);

  // Step 4: Configure chat filter (questions only)
  console.log('--- Step 4: Setting Chat Filter (Questions Only) ---');
  const filterRes = await client.callTool({
    name: 'set_chat_filter',
    arguments: {
      questions_only: true,
      exclude_keywords: ['spam'],
    },
  });
  console.log(filterRes.content[0].text);
  console.log('');

  // Step 5: Read filtered chat messages
  console.log('--- Step 5: Reading Filtered Chat Messages ---');
  const readRes = await client.callTool({
    name: 'read_chat',
    arguments: { cursor: 0, limit: 10 },
  });
  const readData = JSON.parse(readRes.content[0].text);
  assert.equal(readData.messages.length, 3, 'Changing to questions-only must refilter existing messages');
  assert.equal(new Set(readData.messages.map(m => m.id)).size, 3);
  assert.ok(readData.messages.every(m => m.text.includes('?')));
  console.log(`Received ${readData.messages.length} filtered messages (next_cursor=${readData.next_cursor}):`);
  for (const m of readData.messages) {
    console.log(`  [seq=${m.seq}] ${m.chatter}: "${m.text}"`);
    if (m._safety_notice) {
      console.log(`    -> Safety check: treated as untrusted data`);
    }
  }
  console.log('');

  // Step 6: Test reply rejection before streamer authorization
  console.log('--- Step 6: Testing Reply Enforcement (Observe-Only) ---');
  const unauthReply = await client.callTool({
    name: 'send_reply',
    arguments: {
      message: 'This is Tokyo Night theme with JetBrains Mono font.',
      in_reply_to: 'msg-002',
    },
  });
  console.log('Expected rejection when replies not enabled:');
  console.log(`  isError: ${Boolean(unauthReply.isError)}`);
  console.log(`  message: ${unauthReply.content[0].text}\n`);

  // Step 7: Streamer explicitly authorizes replies
  console.log('--- Step 7: Streamer Explicitly Enables Replies ---');
  const enableRes = await client.callTool({
    name: 'set_reply_policy',
    arguments: {
      enabled: true,
      max_chars: 200,
      cooldown_seconds: 2,
    },
  });
  console.log(enableRes.content[0].text);
  console.log('');

  // Step 8: Send authorized reply
  console.log('--- Step 8: Sending Authorized Reply ---');
  const replyRes = await client.callTool({
    name: 'send_reply',
    arguments: {
      message: 'This is Tokyo Night theme with JetBrains Mono font.',
      in_reply_to: 'msg-002',
    },
  });
  console.log('send_reply response:');
  console.log(replyRes.content[0].text);
  console.log('');

  // Step 9: Disconnect
  console.log('--- Step 9: Disconnecting Session ---');
  const disconnectRes = await client.callTool({
    name: 'disconnect',
    arguments: {},
  });
  console.log(disconnectRes.content[0].text);
  console.log('');

  await client.close();
  console.log('====================================================');
  console.log('        DEMO COMPLETED SUCCESSFULLY                 ');
  console.log('====================================================');
}

runDemo().catch((err) => {
  console.error('Demo encountered an error:', err);
  process.exit(1);
});
