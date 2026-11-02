import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadCredentials,
  saveCredentials,
  getCredentialStatus,
} from '../src/config/credentials.js';

test('Credentials: load from environment variables', () => {
  const origId = process.env.TWITCH_CLIENT_ID;
  const origToken = process.env.TWITCH_ACCESS_TOKEN;

  try {
    process.env.TWITCH_CLIENT_ID = 'test_client_id_123';
    process.env.TWITCH_ACCESS_TOKEN = 'oauth:abc123tokenXYZ';

    const creds = loadCredentials();
    assert.ok(creds);
    assert.equal(creds.clientId, 'test_client_id_123');
    assert.equal(creds.accessToken, 'abc123tokenXYZ', 'oauth: prefix should be stripped');
    assert.equal(creds.source, 'environment');
  } finally {
    process.env.TWITCH_CLIENT_ID = origId;
    process.env.TWITCH_ACCESS_TOKEN = origToken;
  }
});

test('Credentials: save and load from custom file with 0600 permissions', () => {
  const origConfig = process.env.TWITCH_COPILOT_CONFIG;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-copilot-test-'));
  const testCredPath = path.join(tmpDir, 'test-creds.json');

  try {
    process.env.TWITCH_COPILOT_CONFIG = testCredPath;
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_ACCESS_TOKEN;

    // Save credentials
    saveCredentials('my_client_id', 'my_secret_token_value', testCredPath);
    assert.ok(fs.existsSync(testCredPath));

    if (process.platform !== 'win32') {
      const stats = fs.statSync(testCredPath);
      const mode = stats.mode & 0o777;
      assert.equal(mode, 0o600, 'Credentials file must have 0600 permissions');
    }

    // Load credentials
    const loaded = loadCredentials();
    assert.ok(loaded);
    assert.equal(loaded.clientId, 'my_client_id');
    assert.equal(loaded.accessToken, 'my_secret_token_value');

    // Status display never exposes token characters
    const status = getCredentialStatus();
    assert.equal(status.configured, true);
    assert.equal(status.clientId, 'my_client_id');
    assert.equal(status.tokenConfigured, true);
    assert.equal(status.accessToken, undefined, 'Raw token must not be in status');
  } finally {
    process.env.TWITCH_COPILOT_CONFIG = origConfig;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Credentials: refuse symlink targets', () => {
  if (process.platform === 'win32') return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-copilot-sym-'));
  const realFile = path.join(tmpDir, 'real.json');
  const symFile = path.join(tmpDir, 'symlink.json');

  try {
    fs.writeFileSync(realFile, JSON.stringify({ clientId: 'id', accessToken: 'tok' }), { mode: 0o600 });
    fs.symlinkSync(realFile, symFile);

    process.env.TWITCH_COPILOT_CONFIG = symFile;
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_ACCESS_TOKEN;

    assert.throws(
      () => loadCredentials(),
      /symbolic link/i,
      'Should refuse to load credentials through a symlink'
    );

    assert.throws(
      () => saveCredentials('id', 'tok', symFile),
      /symbolic link/i,
      'Should refuse to write credentials through a symlink'
    );
  } finally {
    delete process.env.TWITCH_COPILOT_CONFIG;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Credentials: corrupt JSON returns generic error without secret leakage', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-copilot-corrupt-'));
  const badFile = path.join(tmpDir, 'corrupt.json');

  try {
    fs.writeFileSync(badFile, '{"clientId": "foo", "accessToken": secret_unquoted_token_val}', { mode: 0o600 });
    process.env.TWITCH_COPILOT_CONFIG = badFile;
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_ACCESS_TOKEN;

    assert.throws(
      () => loadCredentials(),
      (err) => {
        assert.match(err.message, /invalid JSON format/i);
        assert.doesNotMatch(err.message, /secret_unquoted_token_val/i);
        return true;
      }
    );
  } finally {
    delete process.env.TWITCH_COPILOT_CONFIG;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
