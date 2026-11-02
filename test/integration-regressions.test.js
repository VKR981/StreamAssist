import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTwitchCopilotServer } from '../src/mcp/server.js';
import { EventSubClient } from '../src/twitch/eventsub.js';
import { MessageBuffer } from '../src/state/message-buffer.js';
import { MessageFilter } from '../src/filter/message-filter.js';
import { ReplyPolicyManager, TwitchChatClient } from '../src/twitch/chat-api.js';

async function session(t, options = {}) {
  const server = createTwitchCopilotServer(options);
  const client = new Client({ name: 'regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) return { error: result.content[0].text };
    return JSON.parse(result.content[0].text);
  };
}

test('MCP: changing filters immediately refilters existing history and keeps cursors usable', async t => {
  const call = await session(t);
  await call('connect_channel', { demo: true });
  const all = await call('read_chat');
  assert.equal(all.messages.length, 7);
  assert.equal(new Set(all.messages.map(m => m.id)).size, 7);
  assert.ok(all.messages.some(m => m.id === 'msg-005-injection'));
  await call('set_chat_filter', { questions_only: true });
  const questions = await call('read_chat');
  assert.equal(questions.messages.length, 3);
  assert.ok(questions.messages.every(m => m.text.includes('?')));
  assert.equal((await call('read_chat', { cursor: questions.next_cursor })).messages.length, 0);
  await call('set_chat_filter', { include_keywords: ['font'] });
  assert.equal((await call('read_chat')).messages.length, 1);
});

test('MCP: replies require a connection and reset when switching sessions', async t => {
  const call = await session(t);
  assert.ok((await call('set_reply_policy', { enabled: true })).error);
  await call('connect_channel', { demo: true });
  assert.ok((await call('send_reply', { message: 'hello' })).error);
  await call('set_reply_policy', { enabled: true, max_chars: 500 });
  assert.equal((await call('send_reply', { message: '😀'.repeat(300) })).status, 'sent');
  assert.ok((await call('send_reply', { message: 'again' })).error);
  await call('connect_channel', { demo: true });
  assert.equal((await call('connection_status')).reply_policy.enabled, false);
  await call('disconnect');
  assert.equal((await call('wait_for_messages')).disconnected, true);
});

test('MCP: live mode refuses another channel and cleans up missing credentials', async t => {
  const call = await session(t, { loadCredentials: () => ({ clientId: 'fixture', accessToken: 'fixture' }), validateToken: async () => ({ login: 'owner', userId: '1', scopes: ['user:read:chat'] }) });
  assert.match((await call('connect_channel', { channel: 'stranger' })).error, /authenticated Twitch channel/);
  assert.equal((await call('connection_status')).connected, false);
  const empty = await session(t, { loadCredentials: () => null, authFlow: { begin: async () => ({ status: 'authorization_required', verification_url: 'https://www.twitch.tv/activate' }), cancel: () => ({ status: 'cancelled' }), status: () => ({ status: 'not_started' }) } });
  await empty('connect_channel', { demo: true });
  assert.equal((await empty('connect_channel')).status, 'authorization_required');
  assert.equal((await empty('connection_status')).mode, 'disconnected');
});

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  message(data) { return this.onmessage?.({ data: JSON.stringify(data) }); }
  close(code = 1000) { this.closed = true; this.onclose?.({ code }); }
}
const welcome = id => ({ metadata: { message_type: 'session_welcome' }, payload: { session: { id, connected_at: '2026-11-02', keepalive_timeout_seconds: 30 } } });
function eventClient(filter = new MessageFilter()) {
  FakeSocket.instances = [];
  return new EventSubClient({ clientId: 'fixture', accessToken: 'fixture', broadcasterId: '1', userId: '1', buffer: new MessageBuffer(), filter, customWebSocket: FakeSocket });
}

test('EventSub: fresh reconnect resubscribes; handover preserves subscription and ignores old close', async t => {
  const oldFetch = globalThis.fetch; let subscriptions = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: `sub-${++subscriptions}` }] }) });
  t.after(() => { globalThis.fetch = oldFetch; });
  const c = eventClient(); t.after(() => c.disconnect());
  let pending = c.connect(); let ws = c.ws;
  assert.match(ws.url, /^wss:/);
  await ws.message(welcome('first')); await pending;
  ws.close(); c._cleanupTimers();
  pending = c.connect(); ws = c.ws; await ws.message(welcome('second')); await pending;
  assert.equal(subscriptions, 2);
  const handover = c._handleReconnectHandover('wss://eventsub.wss.twitch.tv/ws?reconnect=fixture');
  const next = FakeSocket.instances.at(-1);
  await next.message(welcome('third')); await handover;
  assert.equal(subscriptions, 2);
  assert.equal(ws.closed, true); assert.equal(c.connected, true);
  assert.equal(c.reconnectTimer, null);
  next.close(); assert.equal(c.connected, false); assert.ok(c.reconnectTimer);
});

test('EventSub: disconnect cancels an outstanding handshake', async () => {
  const c = eventClient(); const pending = c.connect();
  const rejected = assert.rejects(pending, /cancelled/);
  c.disconnect(); await rejected;
  assert.equal(c.handshakeTimeoutTimer, null);
});

test('EventSub: in-flight classification cannot repopulate a disconnected session', async () => {
  let release; const filter = { matches: () => new Promise(r => { release = r; }) };
  const c = eventClient(filter);
  const p = c._handleChatMessage({ message_id: 'e' }, { event: { message_id: 'm', chatter_user_id: '2', message: { text: 'question?' } } });
  c.disconnect(); release({ match: true }); await p;
  assert.equal(c.buffer.messages.length, 0);
});

test('Semantic filtering: queue is bounded and invalid updates are atomic', async () => {
  const f = new MessageFilter({ semantic_filter: { enabled: true, model: 'fixture' }, include_keywords: ['question'] });
  assert.throws(() => f.update({ include_keywords: ['changed'], semantic_filter: { enabled: true, endpoint: 'http://example.com' } }));
  assert.deepEqual(f.includeKeywords, ['question']);
  let release; f.evaluateSemantic = () => new Promise(r => { release = r; });
  const work = Array.from({ length: 20 }, () => f.matches({ text: 'question' }));
  const settled = Promise.allSettled(work);
  await Promise.resolve();
  await assert.rejects(f.matches({ text: 'question' }), /queue full/);
  f.update({ semantic_filter: { enabled: false } }); release({ match: true });
  assert.ok((await settled).every(r => r.status === 'rejected'));
  assert.equal(f._pendingSemantic, 0);
});

test('Chat API: concurrent sends respect cooldown and missing is_sent is rejected', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  let requests = 0;
  globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ data: [{ message_id: '1', is_sent: true }] }) }; };
  const client = new TwitchChatClient({ replyPolicy: new ReplyPolicyManager({ enabled: true }) });
  const results = await Promise.all([client.sendMessage('one'), client.sendMessage('two')]);
  assert.equal(requests, 1); assert.equal(results.filter(r => r.success).length, 1);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ message_id: '2' }] }) });
  const another = new TwitchChatClient({ replyPolicy: new ReplyPolicyManager({ enabled: true }) });
  assert.equal((await another.sendMessage('missing flag')).success, false);
});

test('Chat API: absolute rate-limit reset is interpreted as a timestamp', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => ({ status: 429, headers: new Headers({ 'ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 4) }) });
  const policy = new ReplyPolicyManager({ enabled: true });
  const c = new TwitchChatClient({ replyPolicy: policy });
  assert.equal((await c.sendMessage('hello')).success, false);
  assert.ok(policy.rateLimitResetUntil > Date.now());
  assert.ok(policy.rateLimitResetUntil - Date.now() < 6000);
});

test('MCP: missing credentials lead to browser sign-in, approval then connects without token copying',async t=>{
  let creds=null;let pending=false;
  const authFlow={
    begin:async()=>{pending=true;return {status:'authorization_required',verification_url:'https://www.twitch.tv/activate?device-code=FIXTURE',user_code:'FIXTURE'};},
    complete:async()=>{creds={clientId:'fixture',accessToken:'secret-local-only'};pending=false;return {status:'authorized',login:'streamer',user_id:'42'};},
    status:()=>({status:pending?'authorization_required':'not_started'}),cancel:()=>{pending=false;return {status:'cancelled'};}
  };
  class LocalConnection {
    constructor(){this.connected=false;this.sessionId='fixture-session';}
    onStatusChange(fn){this.listener=fn;}
    async connect(){this.connected=true;}
    disconnect(){this.connected=false;}
  }
  const call=await session(t,{loadCredentials:()=>creds,authFlow,validateToken:async()=>({login:'streamer',userId:'42',scopes:['user:read:chat','user:write:chat']}),EventSubClient:LocalConnection});
  const started=await call('connect_channel');assert.equal(started.status,'authorization_required');assert.match(started.verification_url,/twitch.tv/);
  assert.equal((await call('complete_twitch_login')).status,'authorized');
  const connected=await call('connect_channel');assert.equal(connected.status,'connected');assert.equal(connected.channel,'streamer');
  assert.ok(!JSON.stringify(connected).includes('secret-local-only'));
  assert.equal((await call('connection_status')).reply_policy.enabled,false);
});

test('MCP: expired authorization returns a new browser link',async t=>{
  const authFlow={begin:async()=>({status:'authorization_required',verification_url:'https://www.twitch.tv/activate'}),status:()=>({status:'not_started'}),cancel:()=>({status:'cancelled'})};
  const call=await session(t,{loadCredentials:()=>({clientId:'fixture',accessToken:'expired'}),validateToken:async()=>{throw new Error('HTTP 401 invalid or expired');},authFlow});
  assert.equal((await call('connect_channel')).status,'authorization_required');
  assert.equal((await call('connection_status')).connected,false);
});

test('Streamer can send !ask commands from their own account without allowing bot echo loops',async()=>{
  const buffer=new MessageBuffer({botUserId:'1',botLogin:'streamer'});
  const filter=new MessageFilter({command_prefixes:['!ask']});
  const c=new EventSubClient({clientId:'fixture',accessToken:'fixture',broadcasterId:'1',userId:'1',buffer,filter,customWebSocket:FakeSocket});
  const event=(id,text)=>({event:{message_id:id,chatter_user_id:'1',chatter_user_login:'streamer',message:{text}}});
  await c._handleChatMessage({message_id:'evt-hi'},event('hi','hi'));
  await c._handleChatMessage({message_id:'evt-command'},event('command','!ask hello'));
  await c._handleChatMessage({message_id:'evt-answer'},event('answer','Hello! I can see your message.'));
  assert.deepEqual(buffer.read().messages.map(m=>m.text),['!ask hello']);
  const policy=new ReplyPolicyManager({enabled:true});
  assert.equal(policy.canReply('!ask hello').allowed,false);
  assert.equal(policy.canReply('Hello!').allowed,true);
  c.disconnect();
});

test('Switching to !ask filtering clears an earlier questions-only restriction',async t=>{
  const call=await session(t);
  await call('set_chat_filter',{questions_only:true,include_keywords:['font']});
  await call('set_chat_filter',{command_prefixes:['!ask']});
  const status=await call('connection_status');
  assert.equal(status.chat_filter.questions_only,false);
  assert.deepEqual(status.chat_filter.include_keywords,[]);
  await call('connect_channel',{demo:true});
  const read=await call('read_chat');assert.ok(read.messages.some(m=>m.text.startsWith('!ask')));
});
