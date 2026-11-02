#!/usr/bin/env node

/**
 * Manifest and configuration validation script for Twitch Copilot plugin.
 * Validates .codex-plugin/plugin.json, .mcp.json, SKILL.md, and package.json schemas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

let errors = 0;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  errors += 1;
}

console.log('Validating Twitch Copilot plugin manifest and configuration...\n');

// 1. Validate package.json
console.log('1. Checking package.json:');
try {
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.name === 'twitch-copilot') pass('Package name is "twitch-copilot"');
  else fail(`Unexpected package name: ${pkg.name}`);

  if (pkg.type === 'module') pass('ESM module type configured');
  else fail('package.json missing "type": "module"');

  if (pkg.dependencies && pkg.dependencies['@modelcontextprotocol/sdk']) {
    pass('Official @modelcontextprotocol/sdk dependency declared');
  } else {
    fail('Missing @modelcontextprotocol/sdk in dependencies');
  }

  if (pkg.dependencies && pkg.dependencies.zod) {
    pass('Zod dependency declared');
  } else {
    fail('Missing zod in dependencies');
  }
} catch (err) {
  fail(`package.json error: ${err.message}`);
}

// 2. Validate .codex-plugin/plugin.json
console.log('\n2. Checking .codex-plugin/plugin.json:');
try {
  const manifestPath = path.join(rootDir, '.codex-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.name) pass(`Plugin manifest name: "${manifest.name}"`);
    else fail('plugin.json missing "name"');

    if (manifest.mcpServers === "./.mcp.json") pass("MCP configuration referenced using Codex mcpServers field");
    else fail("plugin.json must reference ./.mcp.json through mcpServers");

    if (manifest.skills === "./skills/") pass("Skill directory uses Codex skills field");
    else fail("plugin.json must reference ./skills/");
    if (typeof manifest.author !== "object") fail("Plugin author must be an object");
    if (manifest.mcp || manifest.permissions) fail("Unsupported invented manifest fields");
  } else {
    fail('.codex-plugin/plugin.json does not exist');
  }
} catch (err) {
  fail(`.codex-plugin/plugin.json error: ${err.message}`);
}

// 3. Validate .mcp.json
console.log('\n3. Checking .mcp.json:');
try {
  const mcpPath = path.join(rootDir, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (mcpConfig.mcpServers?.['twitch-copilot']) {
      pass('mcpServers["twitch-copilot"] server defined');
      const srv = mcpConfig.mcpServers['twitch-copilot'];
      if (srv.command === 'node') pass('Server executable is "node"');
      else fail(`Unexpected server command: ${srv.command}`);

      const argsStr = JSON.stringify(srv.args || []);
      if (argsStr.includes('${CLAUDE_PLUGIN_ROOT}') || argsStr.includes('build/server.cjs')) {
        pass('Portable script path configured in args');
      } else {
        fail('Args do not reference build/server.cjs');
      }
    } else {
      fail('Missing "twitch-copilot" server under mcpServers');
    }
  } else {
    fail('.mcp.json does not exist');
  }
} catch (err) {
  fail(`.mcp.json error: ${err.message}`);
}

// 4. Validate SKILL.md
console.log('\n4. Checking SKILL.md:');
try {
  const skillPath = path.join(rootDir, 'skills', 'twitch-copilot', 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    const content = fs.readFileSync(skillPath, 'utf8');
    if (content.includes('twitch-copilot') || content.includes('Twitch Copilot')) {
      pass('SKILL.md defines Twitch Copilot skill');
    }
    if (content.includes('UNTRUSTED') || content.includes('untrusted')) {
      pass('SKILL.md highlights chat content as untrusted data');
    } else {
      fail('SKILL.md missing untrusted chat safety guidelines');
    }
    if (content.includes('connect_channel') && content.includes('wait_for_messages')) {
      pass('SKILL.md documents core tools');
    } else {
      fail('SKILL.md missing core tool references');
    }
  } else {
    fail('SKILL.md does not exist');
  }
} catch (err) {
  fail(`SKILL.md error: ${err.message}`);
}

for (const relative of ['build/server.cjs', 'build/setup-auth.cjs', '.agents/plugins/marketplace.json']) {
  if (fs.existsSync(path.join(rootDir, relative))) pass(`Required distribution file: ${relative}`);
  else fail(`Missing distribution file: ${relative}`);
}

// 5. Secret audit
console.log('\n5. Checking for accidentally tracked credentials or secrets:');
const sensitiveNames = ['.env', 'credentials.json', 'twitch-credentials.json'];
let foundSecret = false;
for (const s of sensitiveNames) {
  if (fs.existsSync(path.join(rootDir, s))) {
    fail(`Forbidden secret file found in repository root: ${s}`);
    foundSecret = true;
  }
}
if (!foundSecret) {
  pass('No credential or secret files detected in repository.');
}

console.log('\n----------------------------------------------------');
if (errors === 0) {
  console.log('✓ Local package validation passed. This does not certify host installation or live Twitch access.');
  process.exit(0);
} else {
  console.error(`✗ Validation FAILED: ${errors} error(s) detected.`);
  process.exit(1);
}
