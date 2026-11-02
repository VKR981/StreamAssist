import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticTransport } from '../src/demo/synthetic-transport.js';
import { MessageBuffer } from '../src/state/message-buffer.js';
import { MessageFilter } from '../src/filter/message-filter.js';
import { ReplyPolicyManager } from '../src/twitch/chat-api.js';

test('SyntheticTransport: emitAll feeds messages and filters properly', async () => {
  const buffer = new MessageBuffer();
  const filter = new MessageFilter(); // matches all by default
  const replyPolicy = new ReplyPolicyManager({ enabled: true });

  const transport = new SyntheticTransport({
    buffer,
    filter,
    replyPolicy,
    channel: 'demo_streamer',
  });

  transport.start(0);
  const results = await transport.emitAll();

  assert.ok(results.length > 0);

  // Check out that duplicate event evt-002 was suppressed
  const dupResult = results.find(r => r.deduped === true);
  assert.ok(dupResult, 'Should have suppressed duplicate event');

  // Check that bot self echo was suppressed
  const echoResult = results.find(r => r.echo === true);
  assert.ok(echoResult, 'Should have suppressed bot echo');

  // Check that prompt injection message was ingested as plain text data without crashing
  const readData = buffer.read(0, 100);
  const injectionMsg = readData.messages.find(m => m.text.includes('SYSTEM OVERRIDE'));
  assert.ok(injectionMsg, 'Prompt injection message stored purely as text');
  assert.equal(injectionMsg.chatter, 'sneaky_hacker');

  transport.stop();
});

test('SyntheticTransport: outbox writes replies to memory without network', () => {
  const buffer = new MessageBuffer();
  const filter = new MessageFilter();
  const replyPolicy = new ReplyPolicyManager({ enabled: false });

  const transport = new SyntheticTransport({
    buffer,
    filter,
    replyPolicy,
    channel: 'demo_streamer',
  });

  // Reply rejected when policy disabled
  const rejectRes = transport.sendReply('Not allowed yet');
  assert.equal(rejectRes.success, false);
  assert.equal(transport.outbox.length, 0);

  // Enable policy and send reply
  replyPolicy.setPolicy({ enabled: true });
  const sendRes = transport.sendReply('Tokyo Night theme', 'msg-002');
  assert.equal(sendRes.success, true);
  assert.equal(sendRes.isSent, true);
  assert.equal(transport.outbox.length, 1);
  assert.equal(transport.outbox[0].text, 'Tokyo Night theme');
  assert.equal(transport.outbox[0].inReplyTo, 'msg-002');

  transport.stop();
});
