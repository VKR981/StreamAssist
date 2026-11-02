#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/setup-auth.js
var import_node_readline = __toESM(require("node:readline"), 1);
var import_node_stream = require("node:stream");

// src/config/credentials.js
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_os = __toESM(require("node:os"), 1);
function getDefaultConfigDir() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || import_node_path.default.join(import_node_os.default.homedir(), "AppData", "Roaming");
    return import_node_path.default.join(appData, "twitch-copilot");
  }
  const home = import_node_os.default.homedir();
  const configHome = process.env.XDG_CONFIG_HOME || import_node_path.default.join(home, ".config");
  return import_node_path.default.join(configHome, "twitch-copilot");
}
function getDefaultCredentialsPath() {
  return import_node_path.default.join(getDefaultConfigDir(), "credentials.json");
}
function getCredentialsPath() {
  if (process.env.TWITCH_COPILOT_CONFIG && process.env.TWITCH_COPILOT_CONFIG.trim() !== "") {
    return import_node_path.default.resolve(process.env.TWITCH_COPILOT_CONFIG.trim());
  }
  return getDefaultCredentialsPath();
}
function sanitizeToken(token) {
  if (typeof token !== "string") return "";
  if (token.startsWith("oauth:")) {
    return token.slice(6).trim();
  }
  return token.trim();
}
function saveCredentials(clientId, accessToken, customPath, metadata = {}) {
  if (!clientId || typeof clientId !== "string" || !clientId.trim()) {
    throw new Error("Client ID must not be empty");
  }
  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("Access Token must not be empty");
  }
  const targetPath = customPath ? import_node_path.default.resolve(customPath) : getDefaultCredentialsPath();
  const isCustom = targetPath !== getDefaultCredentialsPath();
  const targetDir = import_node_path.default.dirname(targetPath);
  if (import_node_fs.default.existsSync(targetPath)) {
    const lstats = import_node_fs.default.lstatSync(targetPath);
    if (lstats.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link credentials file: ${targetPath}`);
    }
  }
  if (!isCustom) {
    if (!import_node_fs.default.existsSync(targetDir)) {
      import_node_fs.default.mkdirSync(targetDir, { recursive: true, mode: 448 });
    }
    if (process.platform !== "win32") {
      try {
        import_node_fs.default.chmodSync(targetDir, 448);
      } catch {
      }
    }
  } else {
    if (!import_node_fs.default.existsSync(targetDir)) {
      import_node_fs.default.mkdirSync(targetDir, { recursive: true });
    }
  }
  const payload = JSON.stringify(
    {
      clientId: clientId.trim(),
      accessToken: sanitizeToken(accessToken),
      ...typeof metadata.refreshToken === "string" && metadata.refreshToken ? { refreshToken: metadata.refreshToken } : {},
      ...Number.isFinite(metadata.expiresAt) ? { expiresAt: metadata.expiresAt } : {},
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    },
    null,
    2
  );
  import_node_fs.default.writeFileSync(targetPath, payload, { mode: 384, encoding: "utf8" });
  if (process.platform !== "win32") {
    try {
      import_node_fs.default.chmodSync(targetPath, 384);
    } catch {
      throw new Error(`Failed to secure credentials file permissions (0600) at ${targetPath}`);
    }
  }
  return targetPath;
}

// src/twitch/auth.js
var TWITCH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
async function validateToken(clientId, accessToken, options = {}) {
  const timeoutMs = options.timeoutMs || 3e4;
  let response;
  try {
    response = await fetch(TWITCH_VALIDATE_URL, {
      method: "GET",
      headers: {
        Authorization: `OAuth ${accessToken}`
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`Twitch auth validation timed out after ${timeoutMs}ms. Check network connection.`);
    }
    throw new Error(`Network error contacting Twitch auth service: ${err.message}`);
  }
  if (response.status === 401) {
    throw new Error(
      'Twitch access token is invalid or expired (HTTP 401). Please re-authenticate using "pnpm run setup-auth" or generate a new token with scopes "user:read:chat user:write:chat".'
    );
  }
  if (!response.ok) {
    throw new Error(`Twitch auth validation failed with status ${response.status}. Please verify your credentials.`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Failed to parse Twitch OAuth validation response as JSON.");
  }
  if (!data.user_id || !data.login) {
    throw new Error("Twitch OAuth token validation returned no user ID or login. Expected user access token.");
  }
  if (clientId && data.client_id !== clientId) {
    throw new Error(
      `Client ID mismatch: token belongs to client "${data.client_id}", but configured client ID is "${clientId}".`
    );
  }
  const scopes = Array.isArray(data.scopes) ? data.scopes : [];
  const hasReadScope = scopes.includes("user:read:chat");
  if (!hasReadScope) {
    throw new Error(
      `Twitch access token is missing required scope "user:read:chat". Current scopes: [${scopes.join(", ")}]. Run "pnpm run setup-auth" to update.`
    );
  }
  return {
    userId: data.user_id,
    login: data.login,
    clientId: data.client_id,
    scopes,
    hasWriteScope: scopes.includes("user:write:chat"),
    expiresIn: data.expires_in
  };
}

// scripts/setup-auth.js
function askHidden(promptText) {
  if (!process.stdin.isTTY) throw new Error("Run setup-auth in an interactive terminal. Do not paste tokens into Codex chat.");
  return new Promise((resolve, reject) => {
    const muted = new import_node_stream.Writable({ write(_chunk, _encoding, callback) {
      callback();
    } });
    const rl = import_node_readline.default.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(promptText);
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("Setup cancelled."));
    });
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim().replace(/^oauth:/, ""));
    });
  });
}
function ask(promptText) {
  return new Promise((resolve) => {
    const rl = import_node_readline.default.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(promptText, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}
async function main() {
  console.log("========================================================");
  console.log("         TWITCH COPILOT - CREDENTIAL SETUP              ");
  console.log("========================================================\n");
  console.log("This wizard configures credentials locally for Twitch Copilot.");
  console.log("Credentials are saved strictly on this machine (permissions 0600).\n");
  console.log("Required Twitch Scopes:");
  console.log("  - user:read:chat  (to read channel chat messages)");
  console.log("  - user:write:chat (to send authorized replies)\n");
  console.log("Obtaining credentials via official Twitch CLI:");
  console.log("  1. Register an application at https://dev.twitch.tv/console/apps");
  console.log("     Set OAuth Redirect URL to http://localhost:3000");
  console.log('  2. Run: twitch token --user-token --scopes "user:read:chat user:write:chat"\n');
  const clientId = await ask("Enter Twitch Client ID: ");
  if (!clientId) {
    console.error("Error: Client ID cannot be empty.");
    process.exit(1);
  }
  const token = await askHidden("Enter Twitch User Access Token (hidden): ");
  if (!token) {
    console.error("Error: Access token cannot be empty.");
    process.exit(1);
  }
  console.log("\nValidating token with Twitch API...");
  try {
    const info = await validateToken(clientId, token);
    console.log(`\u2713 Token validated for Twitch user: @${info.login} (ID: ${info.userId})`);
    console.log(`\u2713 Active scopes: [${info.scopes.join(", ")}]`);
    if (!info.hasWriteScope) {
      console.warn('\u26A0 Notice: Scope "user:write:chat" is missing. Replies will be disabled.');
    }
    const savedPath = saveCredentials(clientId, token, getCredentialsPath());
    console.log(`
\u2713 Credentials securely saved to: ${savedPath}`);
    console.log("\u2713 File mode set to 0600 (owner-only access).\n");
    console.log("You can now run Twitch Copilot live in Codex.");
  } catch (err) {
    console.error(`
\u2717 Validation failed: ${err.message}`);
    console.error("Credentials were NOT saved.");
    process.exit(1);
  }
}
main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
