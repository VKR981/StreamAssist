import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchModerationClient } from '../src/twitch/moderation-api.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTwitchCopilotServer } from '../src/mcp/server.js';
const scopes = ['moderator:manage:chat_messages', 'moderator:manage:banned_users'];
function fixture(fetchImpl, extra = {}) { return new TwitchModerationClient({ clientId: 'fixture', accessToken: 'secret-fixture', broadcasterId: '1', moderatorId: '1', scopes, fetchImpl, ...extra }); }
test('Deletion requires a specific target; never clears all chat', async () => {
 let calls = 0;
 const c = fixture(async (url, options) => { calls++; assert.equal(url.searchParams.get('message_id'), 'msg1'); assert.equal(url.searchParams.get('broadcaster_id'), '1'); assert.equal(options.method, 'DELETE'); return new Response(null, { status: 204 }); });
 await assert.rejects(c.execute('delete', {}), /specific message_id/);
 assert.equal(calls, 0);
 assert.equal((await c.execute('delete', { message_id: 'msg1' })).status, 'confirmed');
});
test('Moderation checks scopes, duration and protected identity before network', async () => {
 const c = fixture(() => { throw new Error('must not fetch'); });
 await assert.rejects(fixture(null, { scopes: [] }).execute('delete', { message_id: 'x' }), /Sign in again/);
 for (const duration_seconds of [0, 1.5, 1209601]) await assert.rejects(c.execute('timeout', { user_id: '2', duration_seconds, reason: 'spam' }), /Timeout must/);
 await assert.rejects(c.execute('ban', { user_id: '1', reason: 'spam' }), /broadcaster/);
});
test('Timeout includes duration; permanent ban omits it; unban uses DELETE', async () => {
 const calls=[];
 const c = fixture(async (url, options) => { calls.push({ url, options }); return options.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ data: [{ user_id: '2', broadcaster_id: '1' }] }); });
 await c.execute('timeout', { user_id: '2', duration_seconds: 60, reason: 'Spam' });
 await c.execute('ban', { user_id: '2', reason: 'Repeated spam' });
 await c.execute('unban', { user_id: '2' });
 assert.equal(JSON.parse(calls[0].options.body).data.duration, 60);
 assert.equal(Object.hasOwn(JSON.parse(calls[1].options.body).data, 'duration'), false);
 assert.equal(calls[2].options.method, 'DELETE');
 assert.equal(calls[2].url.searchParams.get('user_id'), '2');
});
test('Failures and malformed receipts never report success; no retry', async () => {
 for (const status of [400,401,403,404,409,500]) await assert.rejects(fixture(async()=>new Response(null,{status})).execute('delete',{message_id:'x'}), new RegExp(String(status)));
 await assert.rejects(fixture(async()=>Response.json({data:[]})).execute('ban',{user_id:'2',reason:'spam'}), /no matching/);
 let calls=0;const c=fixture(async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'20'}});});
 await assert.rejects(c.execute('delete',{message_id:'x'}), /429/);
 await assert.rejects(c.execute('delete',{message_id:'x'}), /rate limit active/);
 assert.equal(calls,1);
 c.abort();await assert.rejects(c.execute('delete',{message_id:'x'}), /ended/);
});
test('MCP moderation defaults off, requires explicit actions and guidelines, resets on reconnect', async t => {
 const server=createTwitchCopilotServer(); const client=new Client({name:'modtest',version:'1'}); const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 t.after(async()=>{await client.close();await server.close();});
 const call=(name,args={})=>client.callTool({name,arguments:args});
 await call('connect_channel',{demo:true});
 assert.equal((await call('delete_chat_message',{message_id:'x'})).isError,true);
 assert.equal((await call('set_moderation_policy',{enabled:true})).isError,true);
 await call('set_moderation_policy',{enabled:true,allowed_actions:['delete'],guidelines:'Delete MODERATION_DEMO test messages.'});
 assert.equal(JSON.parse((await call('delete_chat_message',{message_id:'x'})).content[0].text).status,'simulated');
 assert.equal((await call('ban_user',{user_id:'2',reason:'spam'})).isError,true);
 assert.equal((await call('delete_chat_message',{})).isError,true);
 await call('connect_channel',{demo:true});
 assert.equal((await call('delete_chat_message',{message_id:'x'})).isError,true);
});
