import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EventSubClient } from '../src/twitch/eventsub.js';
import { MessageBuffer } from '../src/state/message-buffer.js';
import { MessageFilter } from '../src/filter/message-filter.js';

class MockWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    MockWebSocket.lastInstance = this;
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 5);
  }

  send(data) {
    this.emit('sent', data);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }

  simulateMessage(obj) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(obj) });
    }
  }
}

test('EventSubClient: connects on session_welcome and creates subscription', async () => {
  const origFetch = globalThis.fetch;
  const buffer = new MessageBuffer();
  const filter = new MessageFilter();

  try {
    let subCalled = false;
    globalThis.fetch = async (url) => {
      if (url.includes('subscriptions')) {
        subCalled = true;
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'sub-123' }] }),
        };
      }
      return { ok: false };
    };

    const client = new EventSubClient({
      clientId: 'cid',
      accessToken: 'tok',
      broadcasterId: 'b1',
      userId: 'u1',
      buffer,
      filter,
      customWebSocket: MockWebSocket,
    });

    const connectPromise = client.connect();

    // Wait for mock socket instantiation
    await new Promise(r => setTimeout(r, 10));
    assert.ok(MockWebSocket.lastInstance);

    // Simulate session_welcome
    MockWebSocket.lastInstance.simulateMessage({
      metadata: { message_type: 'session_welcome' },
      payload: {
        session: {
          id: 'session-abc-123',
          keepalive_timeout_seconds: 10,
        },
      },
    });

    await connectPromise;
    assert.equal(client.connected, true);
    assert.equal(client.sessionId, 'session-abc-123');
    assert.equal(subCalled, true);

    client.disconnect();
    assert.equal(client.connected, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('EventSubClient: rejects connect if subscription API fails', async () => {
  const origFetch = globalThis.fetch;
  const buffer = new MessageBuffer();
  const filter = new MessageFilter();

  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Forbidden' }),
    });

    const client = new EventSubClient({
      clientId: 'cid',
      accessToken: 'tok',
      broadcasterId: 'b1',
      userId: 'u1',
      buffer,
      filter,
      customWebSocket: MockWebSocket,
    });

    const connectPromise = client.connect();
    await new Promise(r => setTimeout(r, 10));

    MockWebSocket.lastInstance.simulateMessage({
      metadata: { message_type: 'session_welcome' },
      payload: { session: { id: 'session-fail', keepalive_timeout_seconds: 10 } },
    });

    await assert.rejects(
      async () => connectPromise,
      /EventSub subscription failed/i
    );
    assert.equal(client.connected, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('EventSubClient: handles subscription revocation by stopping reconnects', async () => {
  const origFetch = globalThis.fetch;
  const buffer = new MessageBuffer();
  const filter = new MessageFilter();

  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'sub-1' }] }),
    });

    const client = new EventSubClient({
      clientId: 'cid',
      accessToken: 'tok',
      broadcasterId: 'b1',
      userId: 'u1',
      buffer,
      filter,
      customWebSocket: MockWebSocket,
    });

    const p = client.connect();
    await new Promise(r => setTimeout(r, 10));
    MockWebSocket.lastInstance.simulateMessage({
      metadata: { message_type: 'session_welcome' },
      payload: { session: { id: 's1', keepalive_timeout_seconds: 10 } },
    });
    await p;
    assert.equal(client.connected, true);

    // Simulate revocation
    MockWebSocket.lastInstance.simulateMessage({
      metadata: { message_type: 'revocation', subscription_type: 'channel.chat.message' },
      payload: { subscription: { status: 'authorization_revoked' } },
    });

    assert.equal(client.connected, false);
    assert.equal(client.revoked, true);
    assert.equal(client.revocationReason, 'authorization_revoked');
  } finally {
    globalThis.fetch = origFetch;
  }
});
