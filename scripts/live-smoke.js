// Read-only verification of the installed plugin's actual Twitch connection.
// This script never enables replies and never calls send_reply.
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const config = JSON.parse(execFileSync('codex', ['mcp', 'get', 'twitch-copilot', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const transport = config.transport;
const client = new Client({ name: 'twitch-copilot-live-check', version: '1.0' });
let connected = false;
const parse = result => {
  if (result.isError) throw new Error(result.content?.[0]?.text || 'Plugin tool failed.');
  return JSON.parse(result.content[0].text);
};
try {
  await client.connect(new StdioClientTransport({ command: transport.command, args: transport.args, cwd: transport.cwd }));
  const start = parse(await client.callTool({ name: 'connect_channel', arguments: {} }));
  if (start.status !== 'connected' || start.mode !== 'eventsub') throw new Error('Live connection not established; authorize the plugin first.');
  connected = true;
  const status = parse(await client.callTool({ name: 'connection_status', arguments: {} }));
  if (!status.connected || status.reply_policy.enabled) throw new Error('Connection state or observe-only policy is incorrect.');
  const read = parse(await client.callTool({ name: 'read_chat', arguments: { limit: 5 } }));
  const waited = parse(await client.callTool({ name: 'wait_for_messages', arguments: { cursor: read.next_cursor, timeout: 5 } }));
  console.log(JSON.stringify({ status: 'verified', channel: status.channel, transport: 'Twitch EventSub WebSocket', replies_enabled: false, received_message_count: read.count + waited.count, note: 'Real subscription established. No chat messages posted. Test connection will now close.' }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (connected) { try { await client.callTool({ name: 'disconnect', arguments: {} }); } catch {} }
  try { await client.close(); } catch {}
}
