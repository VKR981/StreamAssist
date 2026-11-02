import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTwitchCopilotServer } from '../src/mcp/server.js';

test('MCP Server: tools registration, demo connect, chat read, and disconnect', async () => {
  const server = createTwitchCopilotServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'test-codex-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  // 1. List tools
  const toolsResult = await client.listTools();
  assert.ok(toolsResult.tools.length >= 8);
  const toolNames = toolsResult.tools.map(t => t.name);
  assert.ok(toolNames.includes('connect_channel'));
  assert.ok(toolNames.includes('connection_status'));
  assert.ok(toolNames.includes('read_chat'));
  assert.ok(toolNames.includes('wait_for_messages'));
  assert.ok(toolNames.includes('set_chat_filter'));
  assert.ok(toolNames.includes('set_reply_policy'));
  assert.ok(toolNames.includes('send_reply'));
  assert.ok(toolNames.includes('disconnect'));

  // 2. Connect demo
  const connectRes = await client.callTool({
    name: 'connect_channel',
    arguments: { channel: 'test_streamer', demo: true },
  });
  assert.equal(connectRes.isError, undefined);
  const connectData = JSON.parse(connectRes.content[0].text);
  assert.equal(connectData.status, 'connected');
  assert.equal(connectData.mode, 'demo');

  // 3. Status
  const statusRes = await client.callTool({
    name: 'connection_status',
    arguments: {},
  });
  const statusData = JSON.parse(statusRes.content[0].text);
  assert.equal(statusData.connected, true);
  assert.equal(statusData.mode, 'demo');

  // 4. Read chat
  const readRes = await client.callTool({
    name: 'read_chat',
    arguments: { cursor: 0, limit: 10 },
  });
  const readData = JSON.parse(readRes.content[0].text);
  assert.ok(readData.messages.length > 0);

  // 5. Send reply rejected when policy disabled
  const replyUnauth = await client.callTool({
    name: 'send_reply',
    arguments: { message: 'Unauthorized reply attempt' },
  });
  assert.equal(replyUnauth.isError, true);

  // 6. Enable reply policy
  const enableRes = await client.callTool({
    name: 'set_reply_policy',
    arguments: { enabled: true, max_chars: 100 },
  });
  assert.equal(enableRes.isError, undefined);

  // 7. Send reply allowed
  const replyAuth = await client.callTool({
    name: 'send_reply',
    arguments: { message: 'Authorized demo reply' },
  });
  assert.equal(replyAuth.isError, undefined);
  const replyData = JSON.parse(replyAuth.content[0].text);
  assert.equal(replyData.status, 'sent');
  assert.equal(replyData.mode, 'demo');

  // 8. Disconnect
  const discRes = await client.callTool({
    name: 'disconnect',
    arguments: {},
  });
  assert.equal(discRes.isError, undefined);

  await client.close();
  await server.close();
});
