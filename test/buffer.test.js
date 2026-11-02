import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageBuffer } from '../src/state/message-buffer.js';

test('Buffer: deduplication and echo suppression', () => {
  const buffer = new MessageBuffer({ capacity: 100 });
  buffer.setBotIdentity('bot-123', 'streamerbot');

  // Normal message accepted
  const p1 = buffer.push({
    id: 'msg-1',
    eventId: 'evt-1',
    chatter: 'alice',
    chatterId: 'user-1',
    text: 'Hello!',
  });
  assert.equal(p1.accepted, true);

  // Duplicate message ID rejected
  const p2 = buffer.push({
    id: 'msg-1',
    eventId: 'evt-2',
    chatter: 'alice',
    chatterId: 'user-1',
    text: 'Hello again',
  });
  assert.equal(p2.accepted, false);
  assert.match(p2.reason, /Duplicate message ID/);

  // Duplicate event ID rejected
  const p3 = buffer.push({
    id: 'msg-3',
    eventId: 'evt-1',
    chatter: 'bob',
    chatterId: 'user-2',
    text: 'Different text',
  });
  assert.equal(p3.accepted, false);
  assert.match(p3.reason, /Duplicate event ID/);

  // Bot self-echo by user ID rejected
  const p4 = buffer.push({
    id: 'msg-4',
    eventId: 'evt-4',
    chatter: 'StreamerBot',
    chatterId: 'bot-123',
    text: 'My own message',
  });
  assert.equal(p4.accepted, false);
  assert.match(p4.reason, /self-echo/);

  // Bot self-echo by login rejected
  const p5 = buffer.push({
    id: 'msg-5',
    eventId: 'evt-5',
    chatter: 'StreamerBot',
    chatterLogin: 'streamerbot',
    chatterId: 'user-diff',
    text: 'My own message login',
  });
  assert.equal(p5.accepted, false);
  assert.match(p5.reason, /self-echo/);

  assert.equal(buffer.messages.length, 1);
});

test('Buffer: ring buffer capacity and truncation semantics', () => {
  const buffer = new MessageBuffer({ capacity: 3 });

  buffer.push({ id: 'm1', text: 'First' }); // seq 1
  buffer.push({ id: 'm2', text: 'Second' }); // seq 2
  buffer.push({ id: 'm3', text: 'Third' }); // seq 3

  // No truncation yet
  let readRes = buffer.read(0, 10);
  assert.equal(readRes.messages.length, 3);
  assert.equal(readRes.truncated, false);
  assert.equal(readRes.next_cursor, 3);

  // Push 4th message -> drops seq 1. Oldest is now seq 2.
  buffer.push({ id: 'm4', text: 'Fourth' }); // seq 4

  // Reading from cursor 0 should now report truncated: true because seq 1 was dropped
  readRes = buffer.read(0, 10);
  assert.equal(readRes.messages.length, 3);
  assert.equal(readRes.truncated, true);

  // Reading from cursor = oldestSeq - 1 (i.e. 2 - 1 = 1) has NO gap!
  // It asks for messages > 1, and 2, 3, 4 are all present. Truncated must be false!
  const noGapRes = buffer.read(1, 10);
  assert.equal(noGapRes.messages.length, 3);
  assert.equal(noGapRes.truncated, false);

  // Reading from an older cursor where gap exists:
  // Push 5th message -> oldest is seq 3.
  buffer.push({ id: 'm5', text: 'Fifth' });
  const gapRes = buffer.read(1, 10); // cursor 1, oldest is 3, gap of seq 2!
  assert.equal(gapRes.truncated, true);
});

test('Buffer: waitForMessages resolves immediately if messages exist', async () => {
  const buffer = new MessageBuffer();
  buffer.push({ id: 'm1', text: 'Immediate message' });

  const res = await buffer.waitForMessages(0, 5);
  assert.equal(res.timed_out, false);
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].text, 'Immediate message');
});

test('Buffer: waitForMessages waits and resolves on new message arrival', async () => {
  const buffer = new MessageBuffer();

  const waitPromise = buffer.waitForMessages(0, 5);

  // Push message after 50ms
  setTimeout(() => {
    buffer.push({ id: 'm1', text: 'Arrived after delay' });
  }, 50);

  const res = await waitPromise;
  assert.equal(res.timed_out, false);
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].text, 'Arrived after delay');
});

test('Buffer: waitForMessages times out cleanly', async () => {
  const buffer = new MessageBuffer();

  const start = Date.now();
  const res = await buffer.waitForMessages(0, 1); // 1s timeout
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 900, 'Should wait close to 1 second');
  assert.equal(res.timed_out, true);
  assert.equal(res.messages.length, 0);
});

test('Buffer: enforce concurrent waiter limit', async () => {
  const buffer = new MessageBuffer({ maxWaiters: 2 });

  const w1 = buffer.waitForMessages(0, 5);
  const w2 = buffer.waitForMessages(0, 5);

  // Third waiter should throw limit exceeded
  await assert.rejects(
    async () => buffer.waitForMessages(0, 5),
    /Maximum concurrent wait_for_messages calls/i
  );

  buffer.clearWaiters();
  await Promise.all([w1, w2]);
});

test('Buffer: clearWaiters settles with disconnected reason', async () => {
  const buffer = new MessageBuffer();

  const waitPromise = buffer.waitForMessages(0, 10);
  buffer.clearWaiters('Connection reset by test');

  const res = await waitPromise;
  assert.equal(res.disconnected, true);
  assert.equal(res.reason, 'Connection reset by test');
  assert.equal(res.messages.length, 0);
});
