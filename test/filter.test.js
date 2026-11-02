import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MessageFilter,
  isQuestion,
  validateLoopbackUrl,
} from '../src/filter/message-filter.js';

test('Filter: questions detection heuristics', () => {
  assert.equal(isQuestion('What keyboard is that?'), true);
  assert.equal(isQuestion('How do I run this code?'), true);
  assert.equal(isQuestion('Is this using pnpm?'), true);
  assert.equal(isQuestion('Can you explain line 42?'), true);
  assert.equal(isQuestion('Why not use python???'), true);
  assert.equal(isQuestion('Hello world'), false);
  assert.equal(isQuestion('!ask what is this?'), true);
  assert.equal(isQuestion('poggers'), false);
  assert.equal(isQuestion(''), false);
});

test('Filter: keyword include and exclude rules', () => {
  const filter = new MessageFilter({
    include_keywords: ['setup', 'editor'],
    exclude_keywords: ['spam', 'raid'],
  });

  // Should match include keyword
  assert.equal(filter.matchesBasic({ text: 'What is your editor theme?' }).match, true);
  assert.equal(filter.matchesBasic({ text: 'Nice setup you have there' }).match, true);

  // Should exclude messages with exclude keyword
  assert.equal(filter.matchesBasic({ text: 'Check out this setup spam' }).match, false);
  assert.equal(filter.matchesBasic({ text: 'Incoming raid with editor setup' }).match, false);

  // Should reject messages without any include keyword
  assert.equal(filter.matchesBasic({ text: 'Just general chat chatter' }).match, false);
});

test('Filter: command prefix rule', () => {
  const filter = new MessageFilter({
    command_prefixes: ['!ask', '!q'],
  });

  assert.equal(filter.matchesBasic({ text: '!ask How does EventSub work?' }).match, true);
  assert.equal(filter.matchesBasic({ text: '!q What font is this?' }).match, true);
  assert.equal(filter.matchesBasic({ text: 'How does EventSub work?' }).match, false);
  assert.equal(filter.matchesBasic({ text: '!help me' }).match, false);
});

test('Filter: ReDoS safety with complex viewer input', () => {
  const filter = new MessageFilter({
    include_keywords: ['test'],
    exclude_keywords: ['drop'],
  });

  // Malicious string containing catastrophic regex syntax
  const evilInput = '(([a-z])+)+$'.repeat(20) + '!';
  const start = Date.now();
  const res = filter.matchesBasic({ text: evilInput });
  const duration = Date.now() - start;

  assert.ok(duration < 50, 'String matching must not suffer from catastrophic ReDoS backtracking');
  assert.equal(res.match, false);
});

test('Filter: Ollama endpoint SSRF validation', () => {
  assert.equal(validateLoopbackUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(validateLoopbackUrl('http://localhost:11434/api/generate'), 'http://localhost:11434');

  // Forbidden URLs
  assert.throws(() => validateLoopbackUrl('http://evil.com/api'), /loopback/i);
  assert.throws(() => validateLoopbackUrl('https://127.0.0.1:11434'), /http:/i);
  assert.throws(() => validateLoopbackUrl('http://admin:secret@127.0.0.1:11434'), /credentials/i);
});

test('Filter: semantic filter fail-closed on unreachable endpoint', async () => {
  const filter = new MessageFilter({
    semantic_filter: {
      enabled: true,
      endpoint: 'http://127.0.0.1:65534', // Unused port
      model: 'llama3.2',
    },
  });

  // Must reject / fail closed when Ollama is unavailable
  await assert.rejects(
    async () => {
      await filter.matches({ text: 'What font are you using?' });
    },
    /Semantic filter error/i
  );
});
