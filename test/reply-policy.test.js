import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyPolicyManager, getUnicodeLength } from '../src/twitch/chat-api.js';

test('ReplyPolicy: Unicode character counting', () => {
  assert.equal(getUnicodeLength('hello'), 5);
  assert.equal(getUnicodeLength('👋🌍'), 2, '2 emoji code points');
  assert.equal(getUnicodeLength('こんにちは'), 5);
  assert.equal(getUnicodeLength(''), 0);
});

test('ReplyPolicy: disabled by default and requires explicit enable', () => {
  const policy = new ReplyPolicyManager();
  assert.equal(policy.enabled, false);

  const check1 = policy.canReply('Hello chat!');
  assert.equal(check1.allowed, false);
  assert.match(check1.reason, /Replies are currently disabled/);

  policy.setPolicy({ enabled: true });
  assert.equal(policy.enabled, true);

  const check2 = policy.canReply('Hello chat!');
  assert.equal(check2.allowed, true);
});

test('ReplyPolicy: character limit validation', () => {
  const policy = new ReplyPolicyManager({ enabled: true, maxChars: 10 });

  assert.equal(policy.canReply('1234567890').allowed, true);
  assert.equal(policy.canReply('12345678901').allowed, false);
  assert.match(policy.canReply('12345678901').reason, /exceeds maximum allowed/);
});

test('ReplyPolicy: cooldown enforcement between replies', () => {
  const policy = new ReplyPolicyManager({ enabled: true, cooldownSeconds: 2 });

  assert.equal(policy.canReply('First message').allowed, true);
  policy.recordReplySent();

  // Immediate subsequent reply rejected by cooldown
  const check = policy.canReply('Second message too fast');
  assert.equal(check.allowed, false);
  assert.match(check.reason, /Cooldown active/);
});

test('ReplyPolicy: rate budget per minute enforcement', () => {
  const policy = new ReplyPolicyManager({
    enabled: true,
    cooldownSeconds: 1,
    maxRepliesPerMinute: 2,
  });

  assert.equal(policy.canReply('m1').allowed, true);
  policy.recordReplySent();

  // Reset lastReplyTimestamp to bypass cooldown and test per-minute budget
  policy.lastReplyTimestamp = 0;
  assert.equal(policy.canReply('m2').allowed, true);
  policy.recordReplySent();

  // 3rd reply exceeds 2 replies/minute budget
  policy.lastReplyTimestamp = 0;
  const check = policy.canReply('m3');
  assert.equal(check.allowed, false);
  assert.match(check.reason, /Rate limit budget reached/);
});

test('ReplyPolicy: resetForNewConnection resets enabled state', () => {
  const policy = new ReplyPolicyManager({ enabled: true });
  assert.equal(policy.enabled, true);

  policy.resetForNewConnection();
  assert.equal(policy.enabled, false, 'Must be disabled on new connection');
});
