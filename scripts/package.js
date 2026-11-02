#!/usr/bin/env node

/**
 * Packaging script for Twitch Copilot distribution.
 * Creates dist/twitch-copilot.zip containing source code, manifests, and documentation,
 * strictly excluding node_modules, secrets, credentials, test logs, and temporary files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const zipFile = path.join(distDir, 'twitch-copilot.zip');

console.log('Packaging Twitch Copilot plugin for distribution...\n');

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Remove existing zip if present
if (fs.existsSync(zipFile)) {
  fs.unlinkSync(zipFile);
}

const excludePatterns = [
  'node_modules/*',
  'node_modules',
  '.pnpm-store/*',
  '.pnpm-store',
  'dist/*',
  'dist',
  '*.zip',
  '*.tar.gz',
  '.git/*',
  '.git',
  '.env*',
  '*.env',
  'credentials.json',
  'twitch-credentials.json',
  '*.log',
  'logs/*',
  'coverage/*',
  'scratch/*',
  '.system_generated/*',
  '.DS_Store',
  '*.pem',
  '*.key',
  'TASK.md',
  'AUTH_TASK.md',
  'REVIEW_FIXES.md',
];

const zipArgs = ['-r', zipFile, '.', '-x', ...excludePatterns];

try {
  execFileSync('/usr/bin/zip', zipArgs, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stats = fs.statSync(zipFile);
  const sizeKb = (stats.size / 1024).toFixed(1);

  console.log(`✓ Distribution zip successfully generated!`);
  console.log(`  File: ${zipFile}`);
  console.log(`  Size: ${sizeKb} KB\n`);

  console.log('Zip contents:');
  const listOutput = execFileSync('/usr/bin/unzip', ['-l', zipFile], { encoding: 'utf8' });
  const lines = listOutput.split('\n');
  for (const line of lines.slice(0, 20)) {
    console.log(`  ${line}`);
  }
  if (lines.length > 20) {
    console.log(`  ... and ${lines.length - 20} more files`);
  }

  console.log('\nPackage complete. Node 24 runtime is bundled; source development uses pnpm install.');
} catch (err) {
  console.error('Packaging failed:', err.message);
  process.exit(1);
}
