import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchChatClient, ReplyPolicyManager } from '../src/twitch/chat-api.js';

test('TwitchChatClient: validates is_sent === true and reports drop_reason', async () => {
  const origFetch = globalThis.fetch;

  try {
    // 1. Successful send
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ message_id: 'm123', is_sent: true }],
      }),
    });

    const policy1 = new ReplyPolicyManager({ enabled: true, cooldownSeconds: 1 });
    const client1 = new TwitchChatClient({
      clientId: 'cid',
      accessToken: 'tok',
      broadcasterId: 'b1',
      senderId: 's1',
      replyPolicy: policy1,
    });

    const resSuccess = await client1.sendMessage('Hello chat');
    assert.equal(resSuccess.success, true);
    assert.equal(resSuccess.isSent, true);
    assert.equal(resSuccess.messageId, 'm123');

    // 2. HTTP 200 but message was dropped by moderation (is_sent: false)
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            message_id: 'm124',
            is_sent: false,
            drop_reason: { code: 'automod_blocked', message: 'Blocked by AutoMod' },
          },
        ],
      }),
    });

    const policy2 = new ReplyPolicyManager({ enabled: true, cooldownSeconds: 1 });
    const client2 = new TwitchChatClient({
      clientId: 'cid',
      accessToken: 'tok',
      broadcasterId: 'b1',
      senderId: 's1',
      replyPolicy: policy2,
    });

    const resDrop = await client2.sendMessage('Blocked message');
    assert.equal(resDrop.success, false);
    assert.equal(resDrop.isSent, false);
    assert.match(resDrop.reason, /Blocked by AutoMod/);

    // 3. HTTP 200 but missing is_sent property (must NOT become success)
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ message_id: 'm125' }], // missing is_sent
      }),
    });

    const policy3 = new ReplyPolicyManager({ enabled: true, cooldownSeconds: 1 });
    const client3 = new TwitchChatClient({
      clientId: 'cid',
      accessToken: 'tok',
      broadcasterId: 'b1',
      senderId: 's1',
      replyPolicy: policy3,
    });

    const resMissing = await client3.sendMessage('Missing is_sent message');
    assert.equal(resMissing.success, false);
    assert.equal(resMissing.isSent, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('TwitchChatClient: handles HTTP 429 rate limits with Retry-After', async () => {
  const origFetch = globalThis.fetch;
  const replyPolicy = new ReplyPolicyManager({ enabled: true, cooldownSeconds: 1 });

  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      headers: {
        get: (h) => (h.toLowerCase() === 'retry-after' ? '15' : null),
      },
    });

    const client = new TwitchChatClient({
      clientId: 'cid',
      accessToken: 'tok',
      broadcasterId: 'b1',
      senderId: 's1',
      replyPolicy,
    });

    const res = await client.sendMessage('Test 429');
    assert.equal(res.success, false);
    assert.match(res.reason, /rate limit/i);
    assert.match(res.reason, /15s/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('TwitchChatClient: abort cancels pending sends', async () => {
  const origFetch = globalThis.fetch;
  const replyPolicy = new ReplyPolicyManager({ enabled: true });

  try {
    globalThis.fetch = async (_url, { signal }) => {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    const client = new TwitchChatClient({
      clientId: 'cid',
      accessToken: 'tok',
      broadcasterId: 'b1',
      senderId: 's1',
      replyPolicy,
    });

    const sendPromise = client.sendMessage('Pending message');
    setTimeout(() => client.abort(), 20);

    const res = await sendPromise;
    assert.equal(res.success, false);
    assert.match(res.reason, /aborted/i);
  } finally {
    globalThis.fetch = origFetch;
  }
});
