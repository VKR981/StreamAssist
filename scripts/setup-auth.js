#!/usr/bin/env node

/**
 * Interactive CLI credential setup for Twitch Copilot.
 * Prompts for Client ID and User Access Token with hidden token input.
 * Validates credentials against Twitch API before writing to ~/.config/twitch-copilot/credentials.json (0600).
 */

import readline from 'node:readline';
import { Writable } from 'node:stream';
import { saveCredentials, getCredentialsPath } from '../src/config/credentials.js';
import { validateToken } from '../src/twitch/auth.js';

function askHidden(promptText) {
  if (!process.stdin.isTTY) throw new Error('Run setup-auth in an interactive terminal. Do not paste tokens into Codex chat.');
  return new Promise((resolve, reject) => {
    // Readline handles paste, backspace and terminal raw mode. Its output is
    // muted so neither ordinary keystrokes nor pasted tokens are displayed.
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(promptText);
    rl.on('SIGINT', () => { rl.close(); reject(new Error('Setup cancelled.')); });
    rl.question('', answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim().replace(/^oauth:/, '')); });
  });
}

function ask(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptText, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function main() {
  console.log('========================================================');
  console.log('         TWITCH COPILOT - CREDENTIAL SETUP              ');
  console.log('========================================================\n');
  console.log('This wizard configures credentials locally for Twitch Copilot.');
  console.log('Credentials are saved strictly on this machine (permissions 0600).\n');
  console.log('Required Twitch Scopes:');
  console.log('  - user:read:chat  (to read channel chat messages)');
  console.log('  - user:write:chat (to send authorized replies)\n');
  console.log('Obtaining credentials via official Twitch CLI:');
  console.log('  1. Register an application at https://dev.twitch.tv/console/apps');
  console.log('     Set OAuth Redirect URL to http://localhost:3000');
  console.log('  2. Run: twitch token --user-token --scopes "user:read:chat user:write:chat"\n');

  const clientId = await ask('Enter Twitch Client ID: ');
  if (!clientId) {
    console.error('Error: Client ID cannot be empty.');
    process.exit(1);
  }

  const token = await askHidden('Enter Twitch User Access Token (hidden): ');
  if (!token) {
    console.error('Error: Access token cannot be empty.');
    process.exit(1);
  }

  console.log('\nValidating token with Twitch API...');
  try {
    const info = await validateToken(clientId, token);
    console.log(`✓ Token validated for Twitch user: @${info.login} (ID: ${info.userId})`);
    console.log(`✓ Active scopes: [${info.scopes.join(', ')}]`);

    if (!info.hasWriteScope) {
      console.warn('⚠ Notice: Scope "user:write:chat" is missing. Replies will be disabled.');
    }

    const savedPath = saveCredentials(clientId, token, getCredentialsPath());
    console.log(`\n✓ Credentials securely saved to: ${savedPath}`);
    console.log('✓ File mode set to 0600 (owner-only access).\n');
    console.log('You can now run Twitch Copilot live in Codex.');
  } catch (err) {
    console.error(`\n✗ Validation failed: ${err.message}`);
    console.error('Credentials were NOT saved.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
